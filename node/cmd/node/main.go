// 主节点入口：libp2p Host + GossipSub + 订单广播/订阅 + 撮合引擎 + HTTP/WebSocket API
package main

import (
	"bufio"
	"context"
	"encoding/json"
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

	// 3. GossipSub
	ps, err := p2p.NewGossipSub(ctx, h)
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

	// 8. 订单处理 Handler：新订单入簿并撮合，成交广播
	handler := &orderMatchHandler{
		engine:    matchEngine,
		publisher: orderPub,
		store:     store,
		ws:        wsServer,
		router:    router,
		registry:  registry,
		locker:    locker,
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
				if !storage.OrderExpired(o) && matchEngine.AddOrder(o) {
					restored++
				}
			}
			for _, o := range asks {
				if !storage.OrderExpired(o) && matchEngine.AddOrder(o) {
					restored++
				}
			}
		}
		if restored > 0 {
			log.Printf("[storage] 订单簿已从本地恢复，共 %d 笔", restored)
		}
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
	srv := &api.Server{
		Store:                    store,
		MatchEngine:              matchEngine,
		Publish:                  publishFn,
		NodeType:                 cfg.Node.Type,
		RewardWallet:             cfg.Node.RewardWallet,
		WSServer:                 wsServer,
		RateLimitOrdersPerMinute: cfg.API.RateLimitOrdersPerMinute,
		BlockedTraders:           api.BuildTraderBlacklist(cfg.API.BlockedTraders),
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

// lockForBookOrder 订单入簿前落锁：可用余额校验与验签在 Vault/LockOrder 内完成。
func (l *vaultLocker) lockForBookOrder(order *storage.Order) error {
	so, err := l.signedOrder(order)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	_, tx, err := settlement.LockOrder(ctx, l.rpcURL, l.vault, l.settlement, l.keyHex, so, order.Side)
	if err != nil {
		return err
	}
	log.Printf("[lock] 订单 %s 已落锁 tx=%s", order.OrderID, tx)
	return nil
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
			if h.store != nil {
				_ = h.store.InsertTrade(t)
			}
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
	// 挂单锁定（第十五轮）：启用锁定时先落锁再入簿；落锁失败（可用余额不足、
	// 验签不过等）拒绝该订单，不入簿、不落库。重启恢复路径直接 AddOrder 不经
	// 此处——锁定在首次接受时已上链、跨重启保留，无需重复落锁。
	if h.locker != nil {
		if err := h.locker.lockForBookOrder(order); err != nil {
			log.Printf("[lock] 订单 %s 落锁失败，拒绝入簿: %v", order.OrderID, err)
			return nil
		}
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
				if h.store != nil {
					_ = h.store.InsertTrade(t)
				}
			}
		}
	} else if h.ws != nil {
		// 轻量 relay 模式：无撮合引擎时仍将新订单推给 WS 客户端
		h.ws.BroadcastOrderStatus(order)
	}
	if h.store != nil {
		_ = h.store.InsertOrder(order)
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
	if h.store != nil {
		_ = h.store.InsertTrade(trade)
	}
	return nil
}
