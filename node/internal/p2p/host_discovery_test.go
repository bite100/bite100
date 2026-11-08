package p2p

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// 第 32 轮：DHT 发现接线冒烟——两节点不预先直连，B 仅以 A 为 bootstrap
// 启动 DHT，双方 GossipSub 经 DHT routing discovery 按 topic 自动发现
// 并完成一次消息投递。此前 StartDHT 从未被调用、本路径不存在。
func TestGossipSub_DHTDiscoveryDelivers(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	hA, err := NewHost([]string{"/ip4/127.0.0.1/tcp/0"}, "")
	if err != nil {
		t.Fatal(err)
	}
	defer hA.Close()
	hB, err := NewHost([]string{"/ip4/127.0.0.1/tcp/0"}, "")
	if err != nil {
		t.Fatal(err)
	}
	defer hB.Close()

	kadA, err := StartDHT(ctx, hA, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer kadA.Close()
	bootstrap := fmt.Sprintf("%s/p2p/%s", hA.Addrs()[0].String(), hA.ID().String())
	kadB, err := StartDHT(ctx, hB, []string{bootstrap})
	if err != nil {
		t.Fatal(err)
	}
	defer kadB.Close()

	psA, err := NewGossipSub(ctx, hA, kadA)
	if err != nil {
		t.Fatal(err)
	}
	psB, err := NewGossipSub(ctx, hB, kadB)
	if err != nil {
		t.Fatal(err)
	}

	const topic = "r32-discovery-smoke"
	sub, err := psB.Subscribe(topic)
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Cancel()
	topicA, err := psA.Join(topic)
	if err != nil {
		t.Fatal(err)
	}
	defer topicA.Close()
	// B 侧不再重复 Join：Subscribe 已自动加入 topic（重复 Join 会报错）。

	// 发现 + mesh 建立需要时间：周期重发，直到 B 收到或超时。
	deadline := time.Now().Add(60 * time.Second)
	for {
		_ = topicA.Publish(ctx, []byte("hello-r32"))
		rctx, rcancel := context.WithTimeout(ctx, 3*time.Second)
		msg, err := sub.Next(rctx)
		rcancel()
		if err == nil && string(msg.Data) == "hello-r32" {
			return // 成功：经 DHT 发现互通
		}
		if time.Now().After(deadline) {
			t.Fatalf("60s 内 B 未经 DHT 发现收到 A 的消息（peers A=%d B=%d）",
				len(hA.Network().Peers()), len(hB.Network().Peers()))
		}
	}
}
