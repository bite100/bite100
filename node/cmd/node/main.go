// P2P 节点 - Phase 2 M1：libp2p 基础连通
// 用法：
//   节点 A（监听）：go run ./cmd/node
//   节点 B（连接）：go run ./cmd/node -connect /ip4/127.0.0.1/tcp/4001/p2p/<节点A的PeerID>
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/peerstore"
	"github.com/multiformats/go-multiaddr"
)

const defaultPort = 4001

func main() {
	// 解析 -connect、-port 参数
	var connectAddr string
	port := defaultPort
	for i := 1; i < len(os.Args); i++ {
		if os.Args[i] == "-connect" && i+1 < len(os.Args) {
			connectAddr = os.Args[i+1]
			i++
		} else if os.Args[i] == "-port" && i+1 < len(os.Args) {
			fmt.Sscanf(os.Args[i+1], "%d", &port)
			i++
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 创建 libp2p host
	h, err := libp2p.New(
		libp2p.ListenAddrStrings(fmt.Sprintf("/ip4/0.0.0.0/tcp/%d", port)),
		libp2p.Ping(true),
	)
	if err != nil {
		log.Fatal(err)
	}
	defer h.Close()

	// 连接事件回调
	h.Network().Notify(&network.NotifyBundle{
		ConnectedF: func(n network.Network, c network.Conn) {
			log.Printf("已连接对等节点: %s", c.RemotePeer())
		},
		DisconnectedF: func(n network.Network, c network.Conn) {
			log.Printf("对等节点断开: %s", c.RemotePeer())
		},
	})

	log.Printf("节点启动 | PeerID: %s", h.ID())
	for _, addr := range h.Addrs() {
		log.Printf("  监听: %s/p2p/%s", addr, h.ID())
	}

	if connectAddr != "" {
		// 连接模式：连接到指定节点
		if err := connectToPeer(ctx, h, connectAddr); err != nil {
			log.Fatalf("连接失败: %v", err)
		}
		log.Printf("已连接到远程节点，当前连接数: %d", len(h.Network().Peers()))
	}

	// 等待中断
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
	log.Println("正在退出...")
}

func connectToPeer(ctx context.Context, h host.Host, addrStr string) error {
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
