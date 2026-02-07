package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/peer"

	"github.com/P2P-P2P/p2p/node/internal/api"
	"github.com/P2P-P2P/p2p/node/internal/chain"
	"github.com/P2P-P2P/p2p/node/internal/config"
	"github.com/P2P-P2P/p2p/node/internal/match"
	"github.com/P2P-P2P/p2p/node/internal/metrics"
	"github.com/P2P-P2P/p2p/node/internal/p2p"
	"github.com/P2P-P2P/p2p/node/internal/relay"
	"github.com/P2P-P2P/p2p/node/internal/storage"
	"github.com/P2P-P2P/p2p/node/internal/sync"
)

func main() {
	port := flag.Int("port", 0, "覆盖监听端口，如 4002")
	connectAddr := flag.String("connect", "", "连接 Bootstrap 节点 multiaddr，如 /ip4/127.0.0.1/tcp/4001/p2p/12D3KooW...")
	configPath := flag.String("config", "config.yaml", "配置文件路径")
	publishTopic := flag.String("publish-topic", "", "发送测试消息的 topic（需配合 -publish-msg）")
	publishMsg := flag.String("publish-msg", "", "发送的测试消息内容")
	syncFrom := flag.String("sync-from", "", "从指定 PeerID 拉取历史成交")
	seedTrades := flag.Bool("seed-trades", false, "插入 5 条测试成交（仅 storage 节点）")
	m2AcceptanceLocal := flag.Bool("m2-acceptance-local", false, "M2 本地验收模式（预留）")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("加载配置: %v", err)
	}

	// 端口覆盖
	listenAddrs := cfg.Node.Listen
	if *port > 0 {
		listenAddrs = []string{fmt.Sprintf("/ip4/0.0.0.0/tcp/%d", *port)}
		if *m2AcceptanceLocal {
			listenAddrs = []string{fmt.Sprintf("/ip4/127.0.0.1/tcp/%d", *port)}
		}
	}

	h, err := p2p.NewHost(listenAddrs, cfg.Node.DataDir)
	if err != nil {
		log.Fatalf("创建节点: %v", err)
	}
	defer h.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// DHT 与 Bootstrap
	if _, err := p2p.StartDHT(ctx, h, cfg.Network.Bootstrap); err != nil {
		log.Printf("DHT 启动: %v（可继续运行）", err)
	}

	// GossipSub
	ps, err := p2p.NewGossipSub(ctx, h)
	if err != nil {
		log.Fatalf("GossipSub: %v", err)
	}

	// 存储节点：提前打开 DB，供 Gossip 订阅回调持久化订单/成交（Phase 3.1）
	var store *storage.DB
	if cfg.Node.Type == "storage" {
		store, err = storage.Open(cfg.Node.DataDir)
		if err != nil {
			log.Fatalf("打开数据库: %v", err)
		}
		defer store.Close()

		// 保留期清理
		go store.RunRetention(ctx, cfg.Storage.RetentionMonths)

		// SyncTrades 协议（存储节点）
		sync.Serve(h, store, cfg.Storage.RetentionMonths)

		// -seed-trades
		if *seedTrades {
			if _, err := store.SeedTestTrades(5); err != nil {
				log.Printf("seed trades: %v", err)
			}
		}

		// 链上拉取
		if cfg.Chain.RPCURL != "" && cfg.Chain.AMMPool != "" {
			go func() {
				n, err := chain.FetchRecentSwapTrades(ctx, cfg.Chain.RPCURL, cfg.Chain.AMMPool, cfg.Chain.Token0, cfg.Chain.Token1, store)
				if err != nil {
					log.Printf("[chain] 拉取 Swap 事件: %v", err)
				} else if n > 0 {
					log.Printf("[chain] 已拉取 %d 条 Swap 成交", n)
				}
			}()
		}
	}

	// 贡献采集器
	collector := metrics.NewCollector()

	// 中继节点（Phase 3.3）：限流与信誉
	var relayLimiter *relay.Limiter
	var relayReputation *relay.Reputation
	if cfg.Node.Type == "relay" && (cfg.Relay.RateLimitBytesPerSecPerPeer > 0 || cfg.Relay.RateLimitMsgsPerSecPerPeer > 0) {
		relayLimiter = relay.NewLimiter(cfg.Relay.RateLimitBytesPerSecPerPeer, cfg.Relay.RateLimitMsgsPerSecPerPeer)
		relayReputation = relay.NewReputation()
		log.Printf("[relay] 限流已启用: bytes/peer/s=%d msgs/peer/s=%d", cfg.Relay.RateLimitBytesPerSecPerPeer, cfg.Relay.RateLimitMsgsPerSecPerPeer)
	} else if cfg.Node.Type == "relay" {
		relayReputation = relay.NewReputation()
	}
	if relayLimiter != nil || relayReputation != nil {
		go func() {
			ticker := time.NewTicker(5 * time.Minute)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					if relayLimiter != nil {
						relayLimiter.Prune(10 * time.Minute)
					}
					if relayReputation != nil {
						relayReputation.Prune(30 * time.Minute)
					}
				}
			}
		}()
	}

	// 撮合节点（Phase 3.2）：单主撮合引擎
	var matchEngine *match.Engine
	if cfg.Node.Type == "match" {
		pairTokens := make(map[string]match.PairTokens)
		for pair, pt := range cfg.Match.Pairs {
			pairTokens[pair] = match.PairTokens{Token0: pt.Token0, Token1: pt.Token1}
		}
		matchEngine = match.NewEngine(pairTokens)
		periodDays := cfg.Metrics.ProofPeriodDays
		if periodDays <= 0 {
			periodDays = 7
		}
		matchEngine.SetCurrentPeriod(metrics.CurrentRunningPeriod(periodDays))
		log.Printf("[match] 撮合引擎已启动，交易对: %v", len(pairTokens))
	}

	// 订阅 topics（含 Phase 3.1：order/new、order/cancel、trade/executed、sync/orderbook）
	topics := cfg.Network.Topics
	if len(topics) == 0 {
		topics = []string{
			"/p2p-exchange/sync/trades",
			"/p2p-exchange/sync/orderbook",
			sync.TopicOrderNew,
			sync.TopicOrderCancel,
			sync.TopicTradeExecuted,
			sync.TopicSyncOrderbook,
		}
	}
	var onMessage func(topic string, from peer.ID, data []byte)
	onMessage = func(topic string, from peer.ID, data []byte) {
		if cfg.Node.Type == "relay" {
			if relayLimiter != nil && !relayLimiter.Allow(from, uint64(len(data))) {
				if relayReputation != nil {
					relayReputation.RecordViolation(from)
				}
				log.Printf("[relay] 限流丢弃 来自 %s topic=%s size=%d", from, topic, len(data))
				return
			}
			if relayReputation != nil {
				relayReputation.RecordRelayed(from, uint64(len(data)))
			}
			collector.AddBytesRelayed(len(data))
		}
		if store != nil {
			switch topic {
			case sync.TopicOrderNew:
				sync.PersistOrderNew(store, data)
			case sync.TopicOrderCancel:
				sync.PersistOrderCancel(store, data)
			case sync.TopicTradeExecuted:
				sync.PersistTradeExecuted(store, data)
			case sync.TopicSyncOrderbook:
				sync.PersistOrderbookSnapshot(store, data)
			}
		}
		if matchEngine != nil {
			switch topic {
			case sync.TopicOrderNew:
				o, err := sync.ParseOrderNew(data)
				if err != nil {
					log.Printf("[match] 解析 order/new 失败: %v", err)
					break
				}
				matchEngine.EnsurePair(o.Pair)
				matchEngine.AddOrder(o)
				trades := matchEngine.Match(o)
				for _, tr := range trades {
					payload, _ := json.Marshal(tr)
					topicObj, err := ps.Join(sync.TopicTradeExecuted)
					if err != nil {
						log.Printf("[match] Join trade/executed 失败: %v", err)
						continue
					}
					if err := topicObj.Publish(ctx, payload); err != nil {
						log.Printf("[match] 广播成交失败: %v", err)
					}
				}
				if o.Status == "partial" {
					matchEngine.AddOrder(o)
				}
			case sync.TopicOrderCancel:
				c, err := sync.ParseOrderCancel(data)
				if err != nil {
					log.Printf("[match] 解析 order/cancel 失败: %v", err)
					break
				}
				matchEngine.RemoveOrder("", c.OrderID)
			}
		}
	}
	for _, t := range topics {
		if err := p2p.SubscribeWithHandler(ctx, ps, t, onMessage); err != nil {
			log.Printf("订阅 %s: %v", t, err)
		}
	}

	// 监听地址
	addrInfo := fmt.Sprintf("%s/p2p/%s", h.Addrs()[0], h.ID())
	log.Printf("节点启动 | PeerID: %s\n  监听: %s", h.ID(), addrInfo)

	// -connect
	if *connectAddr != "" {
		if err := p2p.ConnectToPeer(ctx, h, *connectAddr); err != nil {
			log.Printf("连接 %s: %v", *connectAddr, err)
		} else {
			log.Printf("已连接到远程节点，当前连接数: %d", len(h.Network().Peers()))
		}
	}

	// -sync-from：拉取并保存
	if *syncFrom != "" {
		peerID, err := peer.Decode(*syncFrom)
		if err != nil {
			log.Fatalf("无效 PeerID %s: %v", *syncFrom, err)
		}
		downloadStore := store
		downloadDir := cfg.Node.DataDir
		if cfg.Node.Type == "relay" {
			// relay 写入 data_dir/downloads
			downloadDir = cfg.Node.DataDir + "/downloads"
			downloadStore, err = storage.Open(downloadDir)
			if err != nil {
				log.Fatalf("打开下载库: %v", err)
			}
			defer downloadStore.Close()
		}
		now := time.Now().Unix()
		since := now - 365*24*3600 // 一年内
		trades, err := sync.Request(ctx, h, peerID, since, now, 1000)
		if err != nil {
			log.Fatalf("拉取失败: %v", err)
		}
		log.Printf("从 %s 拉取到 %d 条成交", peerID, len(trades))
		if len(trades) > 0 {
			if err := downloadStore.InsertTrades(trades); err != nil {
				log.Fatalf("保存成交: %v", err)
			}
			log.Printf("已下载并保存 %d 条成交至本地", len(trades))
			// 拉取完成后注册 SyncTrades，供其他节点拉取
			sync.Serve(h, downloadStore, cfg.Storage.RetentionMonths)
		}
	}

	// -publish
	if *publishTopic != "" && *publishMsg != "" {
		topic, err := ps.Join(*publishTopic)
		if err != nil {
			log.Printf("加入 topic %s: %v", *publishTopic, err)
		} else if err := topic.Publish(ctx, []byte(*publishMsg)); err != nil {
			log.Printf("发布消息: %v", err)
		} else {
			log.Printf("已发布到 %s: %s", *publishTopic, *publishMsg)
		}
	}

	// 贡献证明：周期检查（撮合节点传入 matchEngine 以统计周期内 tradesMatched/volumeMatched）
	go runProofCheck(ctx, h, cfg, collector, store, matchEngine)

	// HTTP API（Phase 3.5：订单簿、成交、下单/撤单）
	if cfg.API.Listen != "" {
		publishFn := func(topic string, data []byte) error {
			t, err := ps.Join(topic)
			if err != nil {
				return err
			}
			return t.Publish(ctx, data)
		}
		apiSrv := &api.Server{Store: store, MatchEngine: matchEngine, Publish: publishFn, NodeType: cfg.Node.Type}
		apiSrv.Run(cfg.API.Listen)
	}

	// 等待退出
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
	log.Println("节点退出")
}

const relaySnapshotFilename = "last_bytes_relayed_snapshot"

func runProofCheck(ctx context.Context, h host.Host, cfg *config.Config, collector *metrics.Collector, _ *storage.DB, matchEngine *match.Engine) {
	periodDays := cfg.Metrics.ProofPeriodDays
	if periodDays <= 0 {
		periodDays = 7
	}
	outputDir := cfg.Metrics.ProofOutputDir
	if outputDir == "" {
		outputDir = cfg.Node.DataDir + "/proofs"
	}
	// 中继节点：按周期统计转发字节，用上次证明时的累计值做差得到本周期 bytesRelayed
	var lastBytesRelayedSnapshot uint64
	if cfg.Node.Type == "relay" {
		if b, err := os.ReadFile(filepath.Join(outputDir, relaySnapshotFilename)); err == nil {
			fmt.Sscanf(strings.TrimSpace(string(b)), "%d", &lastBytesRelayedSnapshot)
		}
	}
	checkInterval := 10 * time.Minute
	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// 撮合节点：先同步当前周期，便于按周期累计并在此后读取「刚结束周期」的统计
			if matchEngine != nil {
				matchEngine.SetCurrentPeriod(metrics.CurrentRunningPeriod(periodDays))
			}
			periodStr := metrics.PeriodRange(periodDays)
			if metrics.ProofFileExists(outputDir, periodStr) {
				continue
			}
			periodEnd, err := metrics.PeriodEndTime(periodStr)
			if err != nil {
				continue
			}
			if time.Now().UTC().Before(periodEnd) {
				continue
			}
			periodSec := metrics.PeriodSeconds(periodDays)
			uptimeFrac := collector.UptimeFraction(periodSec)
			usedGB, totalGB := float64(0), float64(0)
			if cfg.Node.Type == "storage" {
				used, total := metrics.StorageUsage(cfg.Node.DataDir)
				usedGB = float64(used) / (1024 * 1024 * 1024)
				if total > 0 {
					totalGB = float64(total) / (1024 * 1024 * 1024)
				}
			}
			bytesRelayed := uint64(0)
			if cfg.Node.Type == "relay" {
				total := collector.BytesRelayedTotal()
				if total > lastBytesRelayedSnapshot {
					bytesRelayed = total - lastBytesRelayedSnapshot
				}
			}
			tradesMatched, volumeMatched := uint64(0), uint64(0)
			if cfg.Node.Type == "match" && matchEngine != nil {
				t, volBig := matchEngine.GetPeriodStats(periodStr)
				tradesMatched = t
				volumeMatched = volBig.Uint64() // 超出 uint64 时截断，链上合约为 uint256
			}
			privKey := h.Peerstore().PrivKey(h.ID())
			if privKey == nil {
				log.Printf("[证明] 无法获取私钥")
				continue
			}
			proof, err := metrics.GenerateProof(
				h.ID(), cfg.Node.Type, periodStr,
				uptimeFrac, usedGB, totalGB, bytesRelayed,
				tradesMatched, volumeMatched,
				privKey,
			)
			if err != nil {
				log.Printf("[证明] 生成失败: %v", err)
				continue
			}
			if _, err := metrics.WriteProofToFile(proof, outputDir); err != nil {
				log.Printf("[证明] 写入失败: %v", err)
			} else if cfg.Node.Type == "relay" {
				// 本周期证明已写入，推进快照以便下一周期统计为「增量」
				snapshot := collector.BytesRelayedTotal()
				snapshotPath := filepath.Join(outputDir, relaySnapshotFilename)
				if err := os.MkdirAll(outputDir, 0755); err == nil {
					_ = os.WriteFile(snapshotPath, []byte(fmt.Sprintf("%d", snapshot)), 0644)
				}
				lastBytesRelayedSnapshot = snapshot
			}
		}
	}
}
