// 主节点入口：libp2p Host + GossipSub + 订单广播/订阅 + 撮合引擎 + HTTP/WebSocket API
package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/P2P-P2P/p2p/node/internal/api"
	"github.com/P2P-P2P/p2p/node/internal/config"
	"github.com/P2P-P2P/p2p/node/internal/match"
	"github.com/P2P-P2P/p2p/node/internal/p2p"
	"github.com/P2P-P2P/p2p/node/internal/storage"
	"github.com/P2P-P2P/p2p/node/internal/sync"
	pubsub "github.com/libp2p/go-libp2p-pubsub"
)

func main() {
	port := flag.Int("port", 4001, "libp2p 监听端口")
	configPath := flag.String("config", "config.yaml", "配置文件路径")
	connectAddr := flag.String("connect", "", "连接到的节点 multiaddr")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("加载配置: %v", err)
	}

	// 监听地址（-port 覆盖配置）
	listenAddrs := cfg.Node.Listen
	if *port != 4001 || len(listenAddrs) == 0 {
		listenAddrs = []string{"/ip4/0.0.0.0/tcp/" + strconv.Itoa(*port)}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 1. 创建 libp2p Host
	h, err := p2p.NewHost(listenAddrs, cfg.Node.DataDir)
	if err != nil {
		log.Fatalf("创建 Host: %v", err)
	}
	log.Printf("节点启动 | PeerID: %s", h.ID())
	for _, a := range h.Addrs() {
		log.Printf("  监听: %s/p2p/%s", a, h.ID())
	}

	// 2. 连接 -connect 节点
	if *connectAddr != "" {
		if err := p2p.ConnectToPeer(ctx, h, *connectAddr); err != nil {
			log.Printf("连接对端失败: %v", err)
		} else {
			log.Printf("已连接到远程节点，当前连接数: %d", len(h.Network().Peers()))
		}
	}

	// 3. GossipSub
	ps, err := p2p.NewGossipSub(ctx, h)
	if err != nil {
		log.Fatalf("GossipSub: %v", err)
	}

	// 4. 订单发布器（加入订单/撤单/成交主题）
	orderPub, err := sync.NewOrderPublisher(h, ps)
	if err != nil {
		log.Fatalf("OrderPublisher: %v", err)
	}

	// 5. 撮合引擎（仅 match 节点）
	var matchEngine *match.Engine
	var router *match.Router
	var registry *match.Registry
	localPairs := make([]string, 0)
	
	if cfg.Node.Type == "match" && len(cfg.Match.Pairs) > 0 {
		pairTokens := make(map[string]match.PairTokens)
		for pair, pt := range cfg.Match.Pairs {
			pairTokens[pair] = match.PairTokens{Token0: pt.Token0, Token1: pt.Token1}
			localPairs = append(localPairs, pair)
		}
		matchEngine = match.NewEngine(pairTokens)
		log.Printf("[match] 撮合引擎已启用，交易对: %d", len(pairTokens))
		
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

	// 6. 存储（storage 节点）
	var store *storage.DB
	if cfg.Node.Type == "storage" {
		store, err = storage.Open(cfg.Node.DataDir)
		if err != nil {
			log.Fatalf("打开存储: %v", err)
		}
		log.Printf("[storage] 已打开数据库")
	}

	// 7. WebSocket 服务器（供前端订阅订单簿/成交）
	wsServer := api.NewWSServer()
	go wsServer.Run()

	// 8. 订单处理 Handler：新订单入簿并撮合，成交广播
	handler := &orderMatchHandler{
		engine:    matchEngine,
		publisher:  orderPub,
		store:     store,
		ws:        wsServer,
		router:    router,
		registry:  registry,
	}
	subscriber := sync.NewOrderSubscriber(ps, handler)
	if err := subscriber.Start(ctx); err != nil {
		log.Fatalf("OrderSubscriber: %v", err)
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
		Store:       store,
		MatchEngine: matchEngine,
		Publish:     publishFn,
		NodeType:    cfg.Node.Type,
		WSServer:    wsServer,
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
}

func (h *orderMatchHandler) OnNewOrder(order *storage.Order) error {
	if order == nil || order.OrderID == "" || order.Pair == "" {
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

// processOrderLocally 本地处理订单（撮合）
func (h *orderMatchHandler) processOrderLocally(order *storage.Order) error {
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
