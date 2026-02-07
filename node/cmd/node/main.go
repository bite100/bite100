// P2P 节点 - Phase 2 M1：YAML 配置、DHT、GossipSub
// 用法：
//   go run ./cmd/node [-config config.yaml] [-port N] [-connect <multiaddr>]
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p-pubsub"

	"github.com/P2P-P2P/p2p/node/internal/config"
	"github.com/P2P-P2P/p2p/node/internal/p2p"
)

const defaultPort = 4001
const defaultConfigPath = "config.yaml"

func main() {
	cfgPath := defaultConfigPath
	var connectAddr, publishTopic, publishMsg string
	port := defaultPort
	for i := 1; i < len(os.Args); i++ {
		switch os.Args[i] {
		case "-config":
			if i+1 < len(os.Args) {
				cfgPath = os.Args[i+1]
				i++
			}
		case "-connect":
			if i+1 < len(os.Args) {
				connectAddr = os.Args[i+1]
				i++
			}
		case "-port":
			if i+1 < len(os.Args) {
				fmt.Sscanf(os.Args[i+1], "%d", &port)
				i++
			}
		case "-publish":
			if i+2 < len(os.Args) {
				publishTopic = os.Args[i+1]
				publishMsg = os.Args[i+2]
				i += 2
			}
		}
	}

	cfg, err := config.Load(cfgPath)
	if err != nil {
		log.Fatalf("加载配置 %s: %v", cfgPath, err)
	}

	// CLI -port 覆盖配置中的第一个 tcp 端口
	listenAddrs := make([]string, 0, len(cfg.Node.Listen))
	for _, a := range cfg.Node.Listen {
		listenAddrs = append(listenAddrs, a)
	}
	if len(listenAddrs) == 0 {
		listenAddrs = []string{fmt.Sprintf("/ip4/0.0.0.0/tcp/%d", port)}
	} else if port != defaultPort {
		// 用 -port 替换第一个 listen 的端口
		listenAddrs[0] = fmt.Sprintf("/ip4/0.0.0.0/tcp/%d", port)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	h, err := p2p.NewHost(listenAddrs)
	if err != nil {
		log.Fatal(err)
	}
	defer h.Close()

	h.Network().Notify(&network.NotifyBundle{
		ConnectedF: func(n network.Network, c network.Conn) {
			log.Printf("已连接对等节点: %s", c.RemotePeer())
		},
		DisconnectedF: func(n network.Network, c network.Conn) {
			log.Printf("对等节点断开: %s", c.RemotePeer())
		},
	})

	log.Printf("节点启动 | 类型=%s | PeerID=%s", cfg.Node.Type, h.ID())
	for _, addr := range h.Addrs() {
		log.Printf("  监听: %s/p2p/%s", addr, h.ID())
	}

	// DHT + Bootstrap
	kad, err := p2p.StartDHT(ctx, h, cfg.Network.Bootstrap)
	if err != nil {
		log.Printf("DHT 启动警告: %v（继续运行）", err)
	} else if kad != nil {
		defer kad.Close()
		log.Println("DHT 已启动")
	}

	// GossipSub + 订阅
	var ps *pubsub.PubSub
	ps, err = p2p.NewGossipSub(ctx, h)
	if err != nil {
		log.Printf("GossipSub 启动失败: %v", err)
	} else {
		topics := cfg.Network.Topics
		if len(topics) == 0 {
			topics = []string{"/p2p-exchange/sync/trades"}
		}
		for _, t := range topics {
			if err := p2p.SubscribeAndLog(ctx, ps, t); err != nil {
				log.Printf("订阅 %s: %v", t, err)
			}
		}
	}

	// -connect：连接指定节点
	if connectAddr != "" {
		if err := p2p.ConnectToPeer(ctx, h, connectAddr); err != nil {
			log.Fatalf("连接失败: %v", err)
		}
		log.Printf("已连接到远程节点，当前连接数: %d", len(h.Network().Peers()))
	}

	// -publish：向 topic 发送消息（用于测试 GossipSub）
	if publishTopic != "" && publishMsg != "" && ps != nil {
		if err := ps.Publish(publishTopic, []byte(publishMsg)); err != nil {
			log.Printf("发布失败: %v", err)
		} else {
			log.Printf("已发送到 %s: %s", publishTopic, publishMsg)
		}
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
	log.Println("正在退出...")
	cancel()
	time.Sleep(500 * time.Millisecond)
}
