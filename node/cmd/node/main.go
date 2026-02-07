package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/peer"

	"github.com/P2P-P2P/p2p/node/internal/chain"
	"github.com/P2P-P2P/p2p/node/internal/config"
	"github.com/P2P-P2P/p2p/node/internal/metrics"
	"github.com/P2P-P2P/p2p/node/internal/p2p"
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

	// 贡献采集器
	collector := metrics.NewCollector()

	// 订阅 topics，中继节点统计 bytes relayed
	topics := cfg.Network.Topics
	if len(topics) == 0 {
		topics = []string{"/p2p-exchange/sync/trades", "/p2p-exchange/sync/orderbook"}
	}
	var onMessage func(topic string, from peer.ID, data []byte)
	if cfg.Node.Type == "relay" {
		onMessage = func(topic string, _ peer.ID, data []byte) {
			collector.AddBytesRelayed(len(data))
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

	// 贡献证明：周期检查
	go runProofCheck(ctx, h, cfg, collector, store)

	// 等待退出
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
	log.Println("节点退出")
}

func runProofCheck(ctx context.Context, h host.Host, cfg *config.Config, collector *metrics.Collector, _ *storage.DB) {
	periodDays := cfg.Metrics.ProofPeriodDays
	if periodDays <= 0 {
		periodDays = 7
	}
	outputDir := cfg.Metrics.ProofOutputDir
	if outputDir == "" {
		outputDir = cfg.Node.DataDir + "/proofs"
	}
	checkInterval := 10 * time.Minute
	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
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
				bytesRelayed = collector.BytesRelayedTotal()
			}
			privKey := h.Peerstore().PrivKey(h.ID())
			if privKey == nil {
				log.Printf("[证明] 无法获取私钥")
				continue
			}
			proof, err := metrics.GenerateProof(
				h.ID(), cfg.Node.Type, periodStr,
				uptimeFrac, usedGB, totalGB, bytesRelayed,
				privKey,
			)
			if err != nil {
				log.Printf("[证明] 生成失败: %v", err)
				continue
			}
			if _, err := metrics.WriteProofToFile(proof, outputDir); err != nil {
				log.Printf("[证明] 写入失败: %v", err)
			}
		}
	}
}
