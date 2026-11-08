// 主节点入口：libp2p Host + GossipSub + 订单广播/订阅 + 撮合引擎 + HTTP/WebSocket API
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"math/big"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"github.com/P2P-P2P/p2p/node/internal/api"
	"github.com/P2P-P2P/p2p/node/internal/config"
	"github.com/P2P-P2P/p2p/node/internal/match"
	"github.com/P2P-P2P/p2p/node/internal/p2p"
	"github.com/P2P-P2P/p2p/node/internal/relay"
	"github.com/P2P-P2P/p2p/node/internal/settlement"
	"github.com/P2P-P2P/p2p/node/internal/storage"
	"github.com/P2P-P2P/p2p/node/internal/sync"
	pubsub "github.com/libp2p/go-libp2p-pubsub"
)

// exitFatal 打印错误并退出；Windows 下等待按键避免窗口闪退
func exitFatal(msg string) {
	log.Print(msg)
	if runtime.GOOS == "windows" {
		fmt.Print("按 Enter 键退出...")
		_, _ = bufio.NewReader(os.Stdin).ReadByte()
	}
	os.Exit(1)
}

func exitFatalf(format string, args ...interface{}) {
	log.Printf(format, args...)
	if runtime.GOOS == "windows" {
		fmt.Print("按 Enter 键退出...")
		_, _ = bufio.NewReader(os.Stdin).ReadByte()
	}
	os.Exit(1)
}

func main() {
	port := flag.Int("port", 4001, "libp2p 监听端口")
	configPath := flag.String("config", "config.yaml", "配置文件路径")
	connectAddr := flag.String("connect", "", "连接到的节点 multiaddr")
	rewardWallet := flag.String("reward-wallet", "", "领奖钱包地址（必填；可通过本参数、环境变量 REWARD_WALLET 或配置文件 reward_wallet 设置）")
	modeRelay := flag.Bool("mode-relay", false, "轻量 relay 模式：仅 GossipSub + WebSocket，不启撮合引擎与存储，适合公共 relay 节点")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		exitFatalf("加载配置: %v", err)
	}
	// EIP-712 签名域按链配置（多链地基，第七轮）：chain_id / settlement 来自配置文件；
	// settlement 未配置时传零地址，SetDomain 保持默认 verifyingContract 不变。
	if cfg.Chain.ChainID != 0 {
		settlementAddr := common.Address{}
		if cfg.Chain.Settlement != "" {
			if !common.IsHexAddress(cfg.Chain.Settlement) {
				exitFatalf("配置 chain.settlement 地址格式错误: %q", cfg.Chain.Settlement)
			}
			settlementAddr = common.HexToAddress(cfg.Chain.Settlement)
		}
		match.SetDomain(big.NewInt(cfg.Chain.ChainID), settlementAddr)
		log.Printf("  签名域: chainId=%d verifyingContract=%s", cfg.Chain.ChainID, match.CurrentDomain().VerifyingContract)
	}
	// 无配置文件或未设置 api.listen 时默认开启 :8080（便于 Railway/Fly 等云部署）
	if cfg.API.Listen == "" {
		cfg.API.Listen = ":8080"
	}
	// 领奖地址：命令行 > 环境变量 > 配置文件
	w := strings.TrimSpace(*rewardWallet)
	if w == "" {
		w = strings.TrimSpace(cfg.Node.RewardWallet)
	}
	if w == "" {
		exitFatal("未指定领奖钱包地址，节点拒绝启动。请通过 -reward-wallet、环境变量 REWARD_WALLET 或配置文件 node.reward_wallet 设置。")
	}
	if !strings.HasPrefix(w, "0x") || len(w) != 42 {
		exitFatalf("领奖钱包地址格式错误：应为 0x 开头的 42 字符（0x+40 位十六进制），当前: %q", w)
	}
	for _, c := range w[2:] {
		if (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F') {
			continue
		}
		exitFatalf("领奖钱包地址含非十六进制字符: %q", w)
	}
	cfg.Node.RewardWallet = w

	// --mode-relay：强制轻量 relay（只广播 + WS，不撮合、不落库）
	if *modeRelay {
		cfg.Node.Type = "relay"
		cfg.Match.Pairs = nil
		log.Print("已启用 --mode-relay：仅 GossipSub + WebSocket，不启撮合与存储")
	}

	// 监听地址（-port 覆盖配置）
	listenAddrs := cfg.Node.Listen
	if *port != 4001 || len(listenAddrs) == 0 {
		listenAddrs = []string{"/ip4/0.0.0.0/tcp/" + strconv.Itoa(*port)}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 1. 创建 libp2p Host（支持可选 Tor 出口）
	hostOpts := p2p.HostOptsFromNetwork(cfg.Network.UseTor, cfg.Network.TorSocksAddr)
	h, err := p2p.NewHostWithOpts(listenAddrs, cfg.Node.DataDir, hostOpts)
	if err != nil {
		exitFatalf("创建 Host: %v", err)
	}
	log.Printf("节点启动 | PeerID: %s", h.ID())
	log.Printf("  领奖地址: %s", cfg.Node.RewardWallet)
	for _, a := range h.Addrs() {
		log.Printf("  监听: %s/p2p/%s", a, h.ID())
	}

	// 2. 连接节点（无中心：-connect 或 config network.bootstrap 均可，任一连上即可参与 Gossip）
	if *connectAddr != "" {
		if err := p2p.ConnectToPeer(ctx, h, *connectAddr); err != nil {
			log.Printf("连接 -connect 失败: %v", err)
		} else {
			log.Printf("已连接 -connect，当前连接数: %d", len(h.Network().Peers()))
		}
	}
	// bootstrap 并行连接，加快启动
	for _, addrStr := range cfg.Network.Bootstrap {
		if addrStr == "" {
			continue
		}
		addrStr := addrStr
		go func() {
			if err := p2p.ConnectToPeer(ctx, h, addrStr); err != nil {
				log.Printf("连接 bootstrap %q 失败: %v", addrStr, err)
			} else {
				log.Printf("已连接 bootstrap，当前连接数: %d", len(h.Network().Peers()))
			}
		}()
	}
	if len(cfg.Network.Bootstrap) > 0 {
		time.Sleep(2 * time.Second) // 留时间让并行连接完成
	}

	// 2.5 DHT：启动 Kademlia DHT 并作为 GossipSub 的发现层（第 32 轮接上；
	// 此前 StartDHT 从未被调用，节点实际只有直连互通）。启动失败不致命：
	// 记录后以无 DHT 发现模式继续运行（-connect/bootstrap 直连仍可用）。
	kad, derr := p2p.StartDHT(ctx, h, cfg.Network.Bootstrap)
	if derr != nil {
		log.Printf("DHT 启动失败（继续以无 DHT 发现模式运行）: %v", derr)
		kad = nil
	}

	// 3. GossipSub
	ps, err := p2p.NewGossipSub(ctx, h, kad)
	if err != nil {
		exitFatalf("GossipSub: %v", err)
	}

	// 3.1 中继 Spam 防护：按 peer 速率限制 + 信誉记录（可用于后续奖励与惩罚）
	var perPeerLimiter *relay.Limiter
	var reputation *relay.Reputation
	if cfg.Relay.RateLimitBytesPerSecPerPeer > 0 || cfg.Relay.RateLimitMsgsPerSecPerPeer > 0 {
		perPeerLimiter = relay.NewLimiter(cfg.Relay.RateLimitBytesPerSecPerPeer, cfg.Relay.RateLimitMsgsPerSecPerPeer)
		reputation = relay.NewReputation()
		log.Printf("[relay] 已启用 Gossip 限流：每 peer 每秒字节上限=%d，每秒消息数上限=%d",
			cfg.Relay.RateLimitBytesPerSecPerPeer, cfg.Relay.RateLimitMsgsPerSecPerPeer)
	}

	// 4. 订单发布器（加入订单/撤单/成交主题）
	orderPub, err := sync.NewOrderPublisher(h, ps)
	if err != nil {
		exitFatalf("OrderPublisher: %v", err)
	}

	// 5. 撮合引擎（match 启用；relay 仅在配置了 pairs 时启用，--mode-relay 时 Pairs 已清空故不启）
	var matchEngine *match.Engine
	var router *match.Router
	var registry *match.Registry
	var pairTokens map[string]match.PairTokens
	localPairs := make([]string, 0)

	enableMatch := cfg.Node.Type == "match" || (cfg.Node.Type == "relay" && len(cfg.Match.Pairs) > 0)
	if enableMatch {
		pairTokens = make(map[string]match.PairTokens)
		for pair, pt := range cfg.Match.Pairs {
			pairTokens[pair] = match.PairTokens{Token0: pt.Token0, Token1: pt.Token1}
			localPairs = append(localPairs, pair)
		}
		matchEngine = match.NewEngine(pairTokens)
		log.Printf("[match] 撮合引擎已启用（%s），交易对: %d", cfg.Node.Type, len(pairTokens))

		// 方案 B：初始化路由和注册表（分片按交易对）
		localPeerID := h.ID().String()
		router = match.NewRouter(localPeerID, matchEngine)
		publishFn := func(topic string, data []byte) error {
			return orderPub.PublishRaw(ctx, topic, data)
		}
		registry = match.NewRegistry(router, localPeerID, localPairs, publishFn)
		registry.Start()
		log.Printf("[router] 路由和注册表已启用，本地交易对: %v", localPairs)

		// 定期清理过期节点
		go func() {
			ticker := time.NewTicker(5 * time.Minute)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					router.CleanupStaleNodes()
				}
			}
		}()
	}

	// 6. 存储（storage 或 带撮合的 relay/match 落库；--mode-relay 不落库）
	needStore := cfg.Node.Type == "storage" || (cfg.Node.Type == "relay" && enableMatch) || (enableMatch && cfg.Node.Type == "match")
	var store *storage.DB
	if needStore {
		store, err = storage.Open(cfg.Node.DataDir)
		if err != nil {
			exitFatalf("打开存储: %v", err)
		}
		log.Printf("[storage] 已打开数据库（%s）", cfg.Node.Type)
	}

	// 7. WebSocket 服务器（供前端订阅订单簿/成交）
	wsServer := api.NewWSServer()
	go wsServer.Run()

	// 挂单锁定（第十五轮）：配置 chain.vault 且环境变量 VAULT_LOCKER_PRIVATE_KEY
	// 存在时启用；未启用时节点行为与此前一致（订单直接入簿、不落锁）。
	var locker *vaultLocker
	if cfg.Chain.Vault != "" {
		if key := os.Getenv("VAULT_LOCKER_PRIVATE_KEY"); key != "" {
			settlementAddr := cfg.Chain.Settlement
			if settlementAddr == "" {
				settlementAddr = match.CurrentDomain().VerifyingContract
			}
			locker = &vaultLocker{rpcURL: cfg.Chain.RPCURL, vault: cfg.Chain.Vault, settlement: settlementAddr, keyHex: key, pairs: pairTokens}
			log.Printf("[lock] 挂单锁定已启用（vault=%s）", cfg.Chain.Vault)
		} else {
			log.Printf("[lock] 已配置 chain.vault 但缺少 VAULT_LOCKER_PRIVATE_KEY，锁定未启用")
		}
	}

	// 结算提交（第二十六轮）：撮合成交落库后由提交器异步提交上链。此前
	// OnTradeExecuted 只落库、SubmitTrade 零调用方，成交从未真正结算——本轮
	// 补齐。启用条件与挂单锁定同源：chain.rpc_url/settlement 已配置且运营私钥
	// （VAULT_LOCKER_PRIVATE_KEY，与 locker 同一身份，即被授权的 relayer）在场。
	var submitter *settlement.Submitter
	if store != nil && cfg.Chain.RPCURL != "" {
		settlementAddr := cfg.Chain.Settlement
		if settlementAddr == "" {
			settlementAddr = match.CurrentDomain().VerifyingContract
		}
		if key := os.Getenv("VAULT_LOCKER_PRIVATE_KEY"); key != "" && settlementAddr != "" {
			sub, err := settlement.NewSubmitter(settlement.SubmitterConfig{
				RPCURL:         cfg.Chain.RPCURL,
				SettlementAddr: settlementAddr,
				PrivateKeyHex:  key,
				Store:          store,
				RebuildOrders: func(t *storage.Trade) error {
					return rebuildTradeOrders(store, pairTokens, t)
				},
			})
			if err != nil {
				log.Printf("[settle] 结算提交器构造失败，未启用: %v", err)
			} else {
				submitter = sub
				log.Printf("[settle] 结算提交器已启用（operator=%s settlement=%s）", sub.Operator(), settlementAddr)
			}
		} else {
			log.Printf("[settle] 已配置 rpc 但缺少运营私钥或 settlement 地址，结算提交未启用")
		}
	}

	// 8. 订单处理 Handler：新订单入簿并撮合，成交广播
	handler := &orderMatchHandler{
		engine:    matchEngine,
		publisher: orderPub,
		store:     store,
		ws:        wsServer,
		router:    router,
		registry:  registry,
		locker:    locker,
		submitter: submitter,
	}
	subscriber := sync.NewOrderSubscriberWithSecurity(ps, handler, perPeerLimiter, reputation)
	if err := subscriber.Start(ctx); err != nil {
		exitFatalf("OrderSubscriber: %v", err)
	}

	// 订单簿持久化：从本地存储恢复 open/partial 订单到撮合引擎（跳过已过期）
	if matchEngine != nil && store != nil && len(localPairs) > 0 {
		restored := 0
		for _, pair := range localPairs {
			bids, asks, err := store.ListOrdersOpenByPair(pair, 500)
			if err != nil {
				log.Printf("[storage] 恢复订单簿 pair=%s: %v", pair, err)
				continue
			}
			for _, o := range bids {
				if restoreBookOrder(store, matchEngine, o) {
					restored++
				}
			}
			for _, o := range asks {
				if restoreBookOrder(store, matchEngine, o) {
					restored++
				}
			}
		}
		if restored > 0 {
			log.Printf("[storage] 订单簿已从本地恢复，共 %d 笔", restored)
		}
	}

	// 结算提交器启动：恢复遗留 submitting + 清扫历史未结算成交并补交，随后
	// 周期清扫兜底（经同步路径落库的成交也由此接管）。
	if submitter != nil {
		submitter.Start(ctx)
	}

	// 订阅节点注册消息（方案 B）
	if registry != nil {
		if err := subscribeMatchRegistry(ctx, ps, registry); err != nil {
			log.Printf("[registry] 订阅注册消息失败: %v", err)
		}
		// 订阅转发订单主题（方案 B）
		if err := subscribeForwardedOrders(ctx, ps, handler); err != nil {
			log.Printf("[router] 订阅转发订单失败: %v", err)
		}
	}

	// 9. API 的 Publish 回调：按主题发布原始字节
	publishFn := func(topic string, data []byte) error {
		return orderPub.PublishRaw(ctx, topic, data)
	}

	// 10. HTTP API
	// 合约用户（做市金库）的 ERC-1271 链上验签兜底需要 RPC 与 Settlement 地址；
	// 未配置时 API 只做纯 ecrecover 验签（EOA 不受影响）。
	apiSettlementAddr := cfg.Chain.Settlement
	if apiSettlementAddr == "" {
		apiSettlementAddr = match.CurrentDomain().VerifyingContract
	}
	srv := &api.Server{
		Store:                    store,
		MatchEngine:              matchEngine,
		Publish:                  publishFn,
		NodeType:                 cfg.Node.Type,
		RewardWallet:             cfg.Node.RewardWallet,
		WSServer:                 wsServer,
		RateLimitOrdersPerMinute: cfg.API.RateLimitOrdersPerMinute,
		BlockedTraders:           api.BuildTraderBlacklist(cfg.API.BlockedTraders),
		RPCURL:                   cfg.Chain.RPCURL,
		SettlementAddr:           apiSettlementAddr,
	}
	if cfg.API.Listen != "" {
		srv.Run(cfg.API.Listen)
	}

	// 11. 优雅退出
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
	log.Println("收到退出信号，关闭...")
	cancel()
}

// subscribeMatchRegistry 订阅节点注册消息（方案 B）
func subscribeMatchRegistry(ctx context.Context, ps *pubsub.PubSub, registry *match.Registry) error {
	topic, err := ps.Join(sync.TopicMatchRegister)
	if err != nil {
		return err
	}

	sub, err := topic.Subscribe()
	if err != nil {
		return err
	}

	go func() {
		defer sub.Cancel()
		for {
			select {
			case <-ctx.Done():
				return
			default:
				msg, err := sub.Next(ctx)
				if err != nil {
					log.Printf("[registry] 订阅错误: %v", err)
					return
				}
				// 处理注册消息
				registry.HandleRegistration(msg.Data)
			}
		}
	}()

	log.Printf("[registry] 已订阅节点注册主题: %s", sync.TopicMatchRegister)
	return nil
}

// subscribeForwardedOrders 订阅转发订单主题（方案 B）
func subscribeForwardedOrders(ctx context.Context, ps *pubsub.PubSub, handler *orderMatchHandler) error {
	// 订阅所有转发订单主题（通配符主题：/p2p-exchange/match/order/*）
	// 注意：libp2p pubsub 不支持通配符，需要订阅具体主题
	// 这里我们订阅一个通用主题，然后根据消息内容判断
	topic, err := ps.Join("/p2p-exchange/match/order")
	if err != nil {
		return err
	}

	sub, err := topic.Subscribe()
	if err != nil {
		return err
	}

	go func() {
		defer sub.Cancel()
		for {
			select {
			case <-ctx.Done():
				return
			default:
				msg, err := sub.Next(ctx)
				if err != nil {
					log.Printf("[router] 订阅转发订单错误: %v", err)
					return
				}
				// 解析订单并本地处理
				var order storage.Order
				if err := json.Unmarshal(msg.Data, &order); err != nil {
					log.Printf("[router] 解析转发订单失败: %v", err)
					continue
				}
				log.Printf("[router] 收到转发订单 %s (pair=%s)", order.OrderID, order.Pair)
				// 本地处理（不再次路由）
				_ = handler.processOrderLocally(&order)
			}
		}
	}()

	log.Printf("[router] 已订阅转发订单主题: /p2p-exchange/match/order")
	return nil
}

// orderMatchHandler 实现 sync.OrderHandler：新订单入簿、撮合、广播成交
type orderMatchHandler struct {
	engine    *match.Engine
	publisher *sync.OrderPublisher
	store     *storage.DB
	ws        *api.WSServer
	router    *match.Router
	registry  *match.Registry
	locker    *vaultLocker
	submitter *settlement.Submitter
}

// recordTrade 成交落库与结算提交的统一入口（第二十六轮）：限价撮合、市价
// 执行、gossip 成交回调三条路径都经此处——先落库（签名订单 JSON 一并持久化），
// 再送结算提交器异步上链。此前三处只 InsertTrade 不提交，成交永不结算。
// 经同步协议（internal/sync）落库的成交不经此处，由提交器周期清扫接管。
func (h *orderMatchHandler) recordTrade(t *storage.Trade) {
	if h.store != nil {
		_ = h.store.InsertTrade(t)
		// 成交量回写（第二十六轮补丁）：撮合量只存在于引擎内存时，重启后
		// 已成交订单会原样回簿并被重复撮合。此处按成交表重算回写，双方订
		// 单的 Filled/Status 自此与成交表一致；重算幂等，gossip 回声无害。
		for _, oid := range []string{t.MakerOrderID, t.TakerOrderID} {
			if oid == "" {
				continue
			}
			if _, _, err := h.store.RecomputeOrderFill(oid); err != nil {
				log.Printf("[storage] 订单 %s 成交量回写失败: %v", oid, err)
			}
		}
	}
	if h.submitter != nil {
		h.submitter.Enqueue(t)
	}
}

// restoreBookOrder 启动恢复时把一笔库内 open 订单接回撮合引擎（第二十六轮
// 补丁）：先按成交表重算已成交量——此前已全额成交却仍为 open 的订单（如旧
// 二进制下撮合后 Filled 从未回写者）直接跳过、不再回簿；部分成交者按剩余
// 量回簿。返回是否已接回引擎。
func restoreBookOrder(store *storage.DB, engine *match.Engine, o *storage.Order) bool {
	if storage.OrderExpired(o) {
		return false
	}
	filled, status, err := store.RecomputeOrderFill(o.OrderID)
	if err != nil {
		log.Printf("[storage] 恢复订单 %s 成交量对账失败（按库内值回簿）: %v", o.OrderID, err)
	} else if status == "filled" {
		log.Printf("[storage] 恢复订单 %s 已全额成交（filled=%s），跳过回簿", o.OrderID, filled)
		return false
	} else {
		o.Filled = filled
	}
	return engine.AddOrder(o)
}

// rebuildTradeOrders 按成交的 maker/taker 订单 ID 从 orders 表重建签名订单
// （match.BuildSignedOrder，与撮合时引擎填充同源等价）：供提交器在成交缺失
// 签名订单时调用——历史成交（本轮之前落库者）与 gossip 成交都没有内存中的
// 签名订单，全靠这条路径恢复结算材料。
func rebuildTradeOrders(store *storage.DB, pairs map[string]match.PairTokens, t *storage.Trade) error {
	pt, ok := pairs[t.Pair]
	if !ok {
		return fmt.Errorf("未知交易对 %s", t.Pair)
	}
	if t.MakerOrder == nil {
		o, err := store.GetOrder(t.MakerOrderID)
		if err != nil {
			return err
		}
		if o == nil {
			return fmt.Errorf("maker 订单 %s 不在订单库", t.MakerOrderID)
		}
		t.MakerOrder = match.BuildSignedOrder(o, &pt)
	}
	if t.TakerOrder == nil {
		o, err := store.GetOrder(t.TakerOrderID)
		if err != nil {
			return err
		}
		if o == nil {
			return fmt.Errorf("taker 订单 %s 不在订单库", t.TakerOrderID)
		}
		t.TakerOrder = match.BuildSignedOrder(o, &pt)
	}
	return nil
}

// vaultLocker 节点侧挂单锁定驱动（第十五轮）：订单接受时落锁、撤单时释放。
// locker 私钥来自环境变量，不落配置文件；启用条件见 main 中的构造处。
type vaultLocker struct {
	rpcURL     string
	vault      string
	settlement string
	keyHex     string
	pairs      map[string]match.PairTokens
}

func (l *vaultLocker) signedOrder(order *storage.Order) (*storage.SignedOrder, error) {
	pt, ok := l.pairs[order.Pair]
	if !ok {
		return nil, fmt.Errorf("未知交易对 %s", order.Pair)
	}
	return match.BuildSignedOrder(order, &pt), nil
}

// lockVerdict 落锁结果的处置分类（第二十九轮）：与 lock.go 注释的契约对齐
// ——已广播未定论（ErrTxPending）不得按失败处理。
type lockVerdict int

const (
	lockOK      lockVerdict = iota // 落锁成功，入簿
	lockTrack                      // 交易已广播仍在途：入簿 + 后台追踪定论
	lockRedrive                    // 交易已丢弃：幂等重驱一次
	lockReject                     // 确定性失败：拒单
)

func classifyLockErr(err error) lockVerdict {
	switch {
	case err == nil:
		return lockOK
	case errors.Is(err, settlement.ErrTxPending):
		return lockTrack
	case errors.Is(err, settlement.ErrTxDropped):
		return lockRedrive
	default:
		return lockReject
	}
}

// lockForBookOrder 订单入簿前落锁：可用余额校验与验签在 Vault/LockOrder 内完成。
//
// 在途政策（第二十九轮，修 ErrTxPending 拒单摩擦）：LockOrder 内部等待上链
// 超时但交易已广播（ErrTxPending）时，锁将在链上生效——此前调用方把任何
// 错误都当失败拒单，与 lock.go「不得按失败处理」的注释自相矛盾，用户被迫
// 在锁其实已上链的情况下反复重发同一订单。现改为：pending 视为在途成功、
// 接受入簿，后台以 LockOrder 幂等重驱追踪定论（锁已上链时凭既有锁直接返回
// 成功；原交易后被丢弃时重驱即重新落锁）；dropped 立即幂等重驱一次；只有
// 确定性失败（余额不足、验签不过等）才拒单。结算时 Vault 强制消费锁定，
// 未落锁的订单无法结算，故「先入簿」不存在无锁成交的风险；残余竞态（成交
// 在落锁确认前被提交结算）由提交器的链上对账与模拟兜底，见轮文档。
func (l *vaultLocker) lockForBookOrder(order *storage.Order) error {
	so, err := l.signedOrder(order)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	_, tx, err := settlement.LockOrder(ctx, l.rpcURL, l.vault, l.settlement, l.keyHex, so, order.Side)
	switch classifyLockErr(err) {
	case lockOK:
		log.Printf("[lock] 订单 %s 已落锁 tx=%s", order.OrderID, tx)
		return nil
	case lockTrack:
		log.Printf("[lock] 订单 %s 落锁交易已广播仍在途，按在途接受入簿并后台追踪: %v", order.OrderID, err)
		go l.trackPendingLock(order)
		return nil
	case lockRedrive:
		log.Printf("[lock] 订单 %s 落锁交易已被丢弃，幂等重驱一次: %v", order.OrderID, err)
		_, tx2, err2 := settlement.LockOrder(ctx, l.rpcURL, l.vault, l.settlement, l.keyHex, so, order.Side)
		switch classifyLockErr(err2) {
		case lockOK:
			log.Printf("[lock] 订单 %s 重驱落锁成功 tx=%s", order.OrderID, tx2)
			return nil
		case lockTrack:
			log.Printf("[lock] 订单 %s 重驱落锁交易在途，接受入簿并后台追踪: %v", order.OrderID, err2)
			go l.trackPendingLock(order)
			return nil
		default:
			return err2
		}
	default:
		return err
	}
}

// trackPendingLock 追踪一笔在途落锁直至定论（第二十九轮）：周期性以
// LockOrder 幂等重驱——LockOrder 先查既有锁，锁已上链即直接返回成功，
// 未上链（原交易后被丢弃）则重新广播落锁。超时仍未确认只记日志：订单
// 的锁定最终由结算端 Vault 消费校验与订单到期/撤单释放路径兜底。
func (l *vaultLocker) trackPendingLock(order *storage.Order) {
	deadline := time.Now().Add(6 * time.Minute)
	for attempt := 1; ; attempt++ {
		time.Sleep(20 * time.Second)
		so, err := l.signedOrder(order)
		if err != nil {
			log.Printf("[lock] 订单 %s 在途落锁追踪中止（签名订单构造失败）: %v", order.OrderID, err)
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
		_, tx, err := settlement.LockOrder(ctx, l.rpcURL, l.vault, l.settlement, l.keyHex, so, order.Side)
		cancel()
		if err == nil {
			log.Printf("[lock] 订单 %s 在途落锁已确认 tx=%s（第 %d 次追踪）", order.OrderID, tx, attempt)
			return
		}
		if time.Now().After(deadline) {
			log.Printf("[lock] 订单 %s 在途落锁追踪超时仍未确认（结算/到期路径兜底）: %v", order.OrderID, err)
			return
		}
	}
}

// releaseForOrder 撤单时按订单摘要释放剩余锁定。
func (l *vaultLocker) releaseForOrder(order *storage.Order) error {
	so, err := l.signedOrder(order)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	digest, err := settlement.OrderDigestByRPC(ctx, l.rpcURL, l.settlement, so)
	if err != nil {
		return err
	}
	tx, err := settlement.ReleaseOrderLock(ctx, l.rpcURL, l.vault, l.keyHex, digest)
	if err != nil {
		return err
	}
	log.Printf("[lock] 订单 %s 锁定已释放 tx=%s", order.OrderID, tx)
	return nil
}

func (h *orderMatchHandler) OnNewOrder(order *storage.Order) error {
	if order == nil || order.OrderID == "" || order.Pair == "" {
		return nil
	}
	if storage.OrderExpired(order) {
		log.Printf("[order/new] 已过期，跳过 orderId=%s expiresAt=%d", order.OrderID, order.ExpiresAt)
		return nil
	}
	// 方案 B：路由订单（如果启用了路由）
	if h.router != nil {
		needForward, targetPeerID, err := h.router.RouteOrder(order)
		if err != nil {
			log.Printf("[router] 路由失败: %v，降级为本地处理", err)
		} else if needForward {
			// 转发到目标节点
			log.Printf("[router] 转发订单 %s (pair=%s) 到节点 %s", order.OrderID, order.Pair, targetPeerID)
			if err := h.forwardOrderToNode(targetPeerID, order); err != nil {
				log.Printf("[router] 转发失败: %v，降级为本地处理", err)
				// 降级：本地处理
				return h.processOrderLocally(order)
			}
			// 转发成功，本地只存储（不撮合）
			if h.store != nil {
				_ = h.store.InsertOrder(order)
			}
			return nil
		}
	}

	// 本地处理
	return h.processOrderLocally(order)
}

// lockRemainder 计算市价单结算后应释放的锁定余量（锁定代币口径）：
// 锁定义务（买 = 签名 amountOut、按保护价；卖 = amountIn）减去全部成交将
// 消费的锁定量。taker 在每笔 Fill 中恒付出 AmountOut（TradeToFill 口径），
// 故消费量 = Σ fill.AmountOut。余量有两种来源：未成交数量，以及买单价格
// 改善（按保护价落锁、按实际价消费）——全额成交的买单同样可能有余量。
// 返回 nil 表示无余量可释放（结算将全额消费）或换算失败。
func (l *vaultLocker) lockRemainder(order *storage.Order, exec *match.MarketExecution) *big.Int {
	if exec == nil || len(exec.Trades) == 0 {
		return nil
	}
	so, err := l.signedOrder(order)
	if err != nil || so == nil {
		return nil
	}
	obligationStr := so.AmountIn
	if order.Side == "buy" {
		obligationStr = so.AmountOut
	}
	obligation, ok := new(big.Int).SetString(obligationStr, 10)
	if !ok {
		return nil
	}
	consumed := new(big.Int)
	for _, tr := range exec.Trades {
		fill, err := settlement.TradeToFill(tr)
		if err != nil {
			return nil
		}
		consumed.Add(consumed, fill.AmountOut)
	}
	rem := new(big.Int).Sub(obligation, consumed)
	if rem.Sign() <= 0 {
		return nil
	}
	return rem
}

// releaseRemainderAsync 市价单余量锁定的异步精确释放（docs/market-orders.md
// §2.5）：等链上剩余量降至 expectedUnused（结算已消费完全部成交）时释放。
// 失败只记日志：订单到期后 releaseExpiredOrderLock 是硬兜底。
func (l *vaultLocker) releaseRemainderAsync(order *storage.Order, expectedUnused *big.Int) {
	so, err := l.signedOrder(order)
	if err != nil {
		log.Printf("[lock] 市价单 %s 余量释放准备失败: %v", order.OrderID, err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	tx, err := settlement.ReleaseRemainderAfterSettlement(ctx, l.rpcURL, l.vault, l.settlement, l.keyHex, so, expectedUnused, 5*time.Second, 14*time.Minute)
	if err != nil {
		log.Printf("[lock] 市价单 %s 余量锁定释放未成（到期后可兜底释放）: %v", order.OrderID, err)
		return
	}
	if tx != "" {
		log.Printf("[lock] 市价单 %s 余量锁定已释放 tx=%s", order.OrderID, tx)
	}
}

// processMarketOrderLocally 市价单本地处理（第十七轮，docs/market-orders.md）：
// 落锁口径与限价单一致（按保护价全额义务）；IOC 执行不入簿；订单以最终
// 状态落库；余量锁定按 §2.5 释放（零成交立即全额、有成交待结算消费后精确
// 释放、全额成交无余量）。
func (h *orderMatchHandler) processMarketOrderLocally(order *storage.Order) error {
	if h.locker != nil {
		if err := h.locker.lockForBookOrder(order); err != nil {
			log.Printf("[lock] 市价单 %s 落锁失败，拒绝执行: %v", order.OrderID, err)
			return nil
		}
	}
	var exec *match.MarketExecution
	if h.engine != nil {
		h.engine.EnsurePair(order.Pair)
		orderCopy := *order
		exec = h.engine.ExecuteMarketOrder(&orderCopy)
		for _, t := range exec.Trades {
			data, _ := json.Marshal(t)
			_ = h.publisher.PublishRaw(context.Background(), sync.TopicTradeExecuted, data)
			if h.ws != nil {
				h.ws.BroadcastTrade(t)
			}
			h.recordTrade(t)
		}
		order.Filled = exec.Executed
		if exec.FullyFilled {
			order.Status = "filled"
		} else {
			order.Status = "cancelled" // IOC：未成交余量立即自动撤销
		}
	} else {
		// 无撮合引擎（纯中继节点）：无法本地执行，按零成交取消落库
		order.Filled = "0"
		order.Status = "cancelled"
	}
	if h.store != nil {
		_ = h.store.InsertOrder(order)
	}
	if h.ws != nil {
		h.ws.BroadcastOrderStatus(order)
	}
	if h.locker != nil {
		switch {
		case exec == nil || len(exec.Trades) == 0:
			// 零成交：无待结算成交，立即全额释放（失败仅记日志）
			if err := h.locker.releaseForOrder(order); err != nil {
				log.Printf("[lock] 市价单 %s 零成交释放锁定未成: %v", order.OrderID, err)
			}
		default:
			// 有成交：余量 = 锁定义务 − 结算将消费量（含未成交余量与买单
			// 价格改善差额）；为 0 时结算全额消费、无需释放
			if rem := h.locker.lockRemainder(order, exec); rem != nil {
				go h.locker.releaseRemainderAsync(order, rem)
			}
		}
	}
	return nil
}

// processOrderLocally 本地处理订单（撮合或仅转发到 WS）
func (h *orderMatchHandler) processOrderLocally(order *storage.Order) error {
	// 市价单走 IOC 专有路径（不入簿、余量自动撤销）
	if order.IsMarketOrder() {
		return h.processMarketOrderLocally(order)
	}
	// 挂单锁定（第十五轮）：启用锁定时先落锁再入簿；落锁确定性失败（可用
	// 余额不足、验签不过等）拒绝该订单，不入簿、不落库；落锁交易在途
	// （ErrTxPending）按在途接受，见 lockForBookOrder 的在途政策（第二十九
	// 轮）。重启恢复路径直接 AddOrder 不经此处——锁定在首次接受时已上链、
	// 跨重启保留，无需重复落锁。
	if h.locker != nil {
		if err := h.locker.lockForBookOrder(order); err != nil {
			log.Printf("[lock] 订单 %s 落锁失败，拒绝入簿: %v", order.OrderID, err)
			return nil
		}
	}
	// 先落库再撮合（第二十九轮修复）：recordTrade 内的 RecomputeOrderFill
	// 以成交表为事实源回写双方订单的 Filled/Status，是成交状态的唯一回写
	// 点。旧顺序（撮合后才 InsertOrder 本单）下，INSERT OR REPLACE 会把
	// 刚回写的成交量覆盖回本单的初始值（filled=0/status=open）——第 27 轮
	// E2E 的 countersell 即如此：链上已结算、库里却恒为 open。先建行再
	// 撮合，回写自然成为最终状态；落锁失败已在上方拒单、不经此处。
	if h.store != nil {
		_ = h.store.InsertOrder(order)
	}
	if h.engine != nil {
		h.engine.EnsurePair(order.Pair)
		if h.engine.AddOrder(order) {
			// 以该订单为 taker 尝试撮合（传副本避免修改原始消息）
			orderCopy := *order
			trades := h.engine.Match(&orderCopy)
			for _, t := range trades {
				data, _ := json.Marshal(t)
				_ = h.publisher.PublishRaw(context.Background(), sync.TopicTradeExecuted, data)
				if h.ws != nil {
					h.ws.BroadcastTrade(t)
				}
				h.recordTrade(t)
			}
		}
	} else if h.ws != nil {
		// 轻量 relay 模式：无撮合引擎时仍将新订单推给 WS 客户端
		h.ws.BroadcastOrderStatus(order)
	}
	return nil
}

// forwardOrderToNode 转发订单到目标节点
func (h *orderMatchHandler) forwardOrderToNode(targetPeerID string, order *storage.Order) error {
	// 使用专用主题转发：/p2p-exchange/match/order/{pair}
	topic := "/p2p-exchange/match/order/" + order.Pair
	data, err := json.Marshal(order)
	if err != nil {
		return err
	}
	return h.publisher.PublishRaw(context.Background(), topic, data)
}

func (h *orderMatchHandler) OnCancelOrder(cancel *sync.CancelRequest) error {
	if cancel == nil || cancel.OrderID == "" {
		return nil
	}
	if h.engine != nil {
		h.engine.RemoveOrder("", cancel.OrderID)
	}
	if h.store != nil {
		existing, _ := h.store.GetOrder(cancel.OrderID)
		if existing != nil {
			_ = h.store.UpdateOrderStatus(cancel.OrderID, "cancelled", existing.Filled)
		}
	}
	// 挂单锁定：撤单释放剩余锁定（失败仅记日志——锁定可能已被结算全部消费，
	// 此时 Vault 释放会 revert，不应阻断撤单本身）。
	if h.locker != nil && h.store != nil {
		if existing, _ := h.store.GetOrder(cancel.OrderID); existing != nil {
			if err := h.locker.releaseForOrder(existing); err != nil {
				log.Printf("[lock] 撤单 %s 释放锁定未成（可能已被结算消费）: %v", cancel.OrderID, err)
			}
		}
	}
	return nil
}

func (h *orderMatchHandler) OnTradeExecuted(trade *storage.Trade) error {
	if trade == nil {
		return nil
	}
	h.recordTrade(trade)
	return nil
}
