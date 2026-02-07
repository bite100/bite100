package p2p

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/peerstore"
	dht "github.com/libp2p/go-libp2p-kad-dht"
	"github.com/libp2p/go-libp2p-pubsub"
	"github.com/multiformats/go-multiaddr"
)

// NewHost 根据监听地址创建 libp2p Host；dataDir 非空时从 dataDir/peerkey 加载或生成并持久化密钥，保证同目录 PeerID 不变
func NewHost(listenAddrs []string, dataDir string) (host.Host, error) {
	if len(listenAddrs) == 0 {
		listenAddrs = []string{"/ip4/0.0.0.0/tcp/4001"}
	}
	opts := []libp2p.Option{
		libp2p.ListenAddrStrings(listenAddrs...),
		libp2p.Ping(true),
		libp2p.NATPortMap(),
	}
	if dataDir != "" {
		priv, err := LoadOrCreateKey(dataDir)
		if err != nil {
			return nil, fmt.Errorf("节点密钥: %w", err)
		}
		if priv != nil {
			opts = append(opts, libp2p.Identity(priv))
		}
	}
	return libp2p.New(opts...)
}

// StartDHT 创建并启动 Kademlia DHT，连接 Bootstrap 节点
func StartDHT(ctx context.Context, h host.Host, bootstrapPeers []string) (*dht.IpfsDHT, error) {
	kad, err := dht.New(ctx, h, dht.Mode(dht.ModeAutoServer))
	if err != nil {
		return nil, fmt.Errorf("new dht: %w", err)
	}
	if err := kad.Bootstrap(ctx); err != nil {
		return nil, fmt.Errorf("dht bootstrap: %w", err)
	}
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
		if err := h.Connect(ctx, *ai); err != nil {
			log.Printf("连接 bootstrap %s: %v", ai.ID, err)
			continue
		}
		log.Printf("已连接 Bootstrap: %s", ai.ID)
	}
	return kad, nil
}

// NewGossipSub 创建 GossipSub（先不接 DHT discovery，仅直连与 -connect 的节点互通）
func NewGossipSub(ctx context.Context, h host.Host) (*pubsub.PubSub, error) {
	return pubsub.NewGossipSub(ctx, h)
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
