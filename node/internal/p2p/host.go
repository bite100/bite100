package p2p

import (
	"context"
	"fmt"
	"log"
	"net"
	"time"

	"github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/peerstore"
	"github.com/libp2p/go-libp2p/p2p/transport/tcp"
	dht "github.com/libp2p/go-libp2p-kad-dht"
	"github.com/libp2p/go-libp2p-pubsub"
	"github.com/multiformats/go-multiaddr"
	"golang.org/x/net/proxy"
)

// HostOpts 可选配置（12.1 Tor 等）
type HostOpts struct {
	UseTor       bool
	TorSocksAddr string // 如 127.0.0.1:9050
}

// HostOptsFromNetwork 从 NetworkConfig 构建 HostOpts；cfg 为 nil 时返回 nil
func HostOptsFromNetwork(useTor bool, torSocksAddr string) *HostOpts {
	if !useTor {
		return nil
	}
	addr := torSocksAddr
	if addr == "" {
		addr = "127.0.0.1:9050"
	}
	return &HostOpts{UseTor: true, TorSocksAddr: addr}
}

// socksContextDialer 包装 proxy.Dialer 以实现 tcp.ContextDialer（DialContext）
type socksContextDialer struct {
	d proxy.Dialer
}

func (s *socksContextDialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	return s.d.Dial(network, addr)
}

// NewHost 根据监听地址创建 libp2p Host；dataDir 非空时从 dataDir/peerkey 加载或生成并持久化密钥
func NewHost(listenAddrs []string, dataDir string) (host.Host, error) {
	return NewHostWithOpts(listenAddrs, dataDir, nil)
}

// NewHostWithOpts 支持 Tor 等可选配置（12.1 节点可选 Tor 出口）
func NewHostWithOpts(listenAddrs []string, dataDir string, opts *HostOpts) (host.Host, error) {
	if len(listenAddrs) == 0 {
		listenAddrs = []string{"/ip4/0.0.0.0/tcp/4001"}
	}
	hostOpts := []libp2p.Option{
		libp2p.ListenAddrStrings(listenAddrs...),
		libp2p.Ping(true),
		libp2p.NATPortMap(),
	}
	if opts != nil && opts.UseTor && opts.TorSocksAddr != "" {
		socksAddr := opts.TorSocksAddr
		socksDialer, err := proxy.SOCKS5("tcp", socksAddr, nil, proxy.Direct)
		if err != nil {
			return nil, fmt.Errorf("创建 Tor SOCKS5 代理: %w", err)
		}
		ctxDialer := &socksContextDialer{d: socksDialer}
		dialerForAddr := func(raddr multiaddr.Multiaddr) (tcp.ContextDialer, error) {
			return ctxDialer, nil
		}
		hostOpts = append(hostOpts,
			libp2p.NoTransports,
			libp2p.Transport(tcp.NewTCPTransport, tcp.WithDialerForAddr(dialerForAddr)),
		)
		log.Printf("P2P 出站经 Tor SOCKS5: %s", socksAddr)
	}
	if dataDir != "" {
		priv, err := LoadOrCreateKey(dataDir)
		if err != nil {
			return nil, fmt.Errorf("节点密钥: %w", err)
		}
		if priv != nil {
			hostOpts = append(hostOpts, libp2p.Identity(priv))
		}
	}
	return libp2p.New(hostOpts...)
}

// StartDHT 创建并启动 Kademlia DHT，连接 Bootstrap 节点（优化：重试、超时、DHT 发现）
func StartDHT(ctx context.Context, h host.Host, bootstrapPeers []string) (*dht.IpfsDHT, error) {
	kad, err := dht.New(ctx, h, dht.Mode(dht.ModeAutoServer))
	if err != nil {
		return nil, fmt.Errorf("new dht: %w", err)
	}
	
	// 连接 Bootstrap 节点（带重试）
	connectedCount := 0
	for _, addrStr := range bootstrapPeers {
		if addrStr == "" {
			continue
		}
		maddr, err := multiaddr.NewMultiaddr(addrStr)
		if err != nil {
			log.Printf("跳过无效 bootstrap 地址 %q: %v", addrStr, err)
			continue
		}
		ai, err := peer.AddrInfoFromP2pAddr(maddr)
		if err != nil {
			log.Printf("解析 bootstrap %q: %v", addrStr, err)
			continue
		}
		h.Peerstore().AddAddrs(ai.ID, ai.Addrs, peerstore.PermanentAddrTTL)
		
		// 重试连接（最多 3 次，每次 5 秒超时）
		var lastErr error
		for retry := 0; retry < 3; retry++ {
			connCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := h.Connect(connCtx, *ai)
			cancel()
			if err == nil {
				log.Printf("已连接 Bootstrap: %s", ai.ID)
				connectedCount++
				break
			}
			lastErr = err
			if retry < 2 {
				time.Sleep(time.Second * time.Duration(retry+1))
			}
		}
		if lastErr != nil && connectedCount == 0 {
			log.Printf("连接 bootstrap %s 失败（已重试）: %v", ai.ID, lastErr)
		}
	}
	
	// 启动 DHT Bootstrap（即使没有直连的 bootstrap，DHT 也会尝试发现）
	if err := kad.Bootstrap(ctx); err != nil {
		log.Printf("DHT bootstrap 警告: %v（将继续运行，可能通过 DHT 发现节点）", err)
	}
	
	if connectedCount > 0 {
		log.Printf("已连接 %d 个 Bootstrap 节点，DHT 已启动", connectedCount)
	} else if len(bootstrapPeers) > 0 {
		log.Printf("未连接到任何 Bootstrap 节点，DHT 将尝试通过路由表发现节点")
	} else {
		log.Printf("未配置 Bootstrap 节点，DHT 将尝试通过路由表发现节点")
	}
	
	return kad, nil
}

// NewGossipSub 创建 GossipSub（先不接 DHT discovery，仅直连与 -connect 的节点互通）
// 清单 1.1 GossipSub 延迟优化：降低 heartbeat、适度提高 fanout 以加快订单广播
func NewGossipSub(ctx context.Context, h host.Host) (*pubsub.PubSub, error) {
	params := pubsub.DefaultGossipSubParams()
	// heartbeat 从 1s 降为 500ms，加快 mesh 维护与 gossip 频率
	params.HeartbeatInterval = 500 * time.Millisecond
	params.HeartbeatInitialDelay = 50 * time.Millisecond
	// fanout 保留时间略短，便于快速重选 mesh 内 peer
	params.FanoutTTL = 30 * time.Second
	return pubsub.NewGossipSub(ctx, h, pubsub.WithGossipSubParams(params))
}

// SubscribeAndLog 订阅 topic 并打印收到的消息（为 M2/M3 打基础）
func SubscribeAndLog(ctx context.Context, ps *pubsub.PubSub, topicName string) error {
	return SubscribeWithHandler(ctx, ps, topicName, nil)
}

// SubscribeWithHandler 订阅 topic，每收到一条消息调用 onMessage（可为 nil 仅打印）；用于中继统计 bytes relayed
func SubscribeWithHandler(ctx context.Context, ps *pubsub.PubSub, topicName string, onMessage func(topic string, from peer.ID, data []byte)) error {
	sub, err := ps.Subscribe(topicName)
	if err != nil {
		return err
	}
	log.Printf("已订阅 topic: %s", topicName)
	go func() {
		defer sub.Cancel()
		for {
			msg, err := sub.Next(ctx)
			if err != nil {
				return
			}
			data := msg.Data
			from := msg.GetFrom()
			if onMessage != nil {
				onMessage(topicName, from, data)
			}
			log.Printf("[%s] 来自 %s: %d bytes", topicName, from, len(data))
		}
	}()
	return nil
}

// ConnectToPeer 连接到指定 multiaddr
func ConnectToPeer(ctx context.Context, h host.Host, addrStr string) error {
	maddr, err := multiaddr.NewMultiaddr(addrStr)
	if err != nil {
		return fmt.Errorf("解析地址: %w", err)
	}
	ai, err := peer.AddrInfoFromP2pAddr(maddr)
	if err != nil {
		return fmt.Errorf("解析 PeerInfo: %w", err)
	}
	h.Peerstore().AddAddrs(ai.ID, ai.Addrs, peerstore.PermanentAddrTTL)
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return h.Connect(ctx, *ai)
}
