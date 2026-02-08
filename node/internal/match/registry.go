package match

import (
	"encoding/json"
	"log"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"
)

// MatchNodeRegistration 节点注册消息
type MatchNodeRegistration struct {
	PeerID    string   `json:"peerId"`
	Pairs     []string `json:"pairs"`
	Capacity  int      `json:"capacity"`
	Timestamp int64    `json:"timestamp"`
}

// Registry 节点注册表：处理节点注册与发现
type Registry struct {
	router     *Router
	localPeerID string
	localPairs  []string
	publish     func(topic string, data []byte) error
}

// NewRegistry 创建注册表
func NewRegistry(router *Router, localPeerID string, localPairs []string, publish func(topic string, data []byte) error) *Registry {
	return &Registry{
		router:      router,
		localPeerID: localPeerID,
		localPairs:  localPairs,
		publish:     publish,
	}
}

// Start 启动注册表（定期广播注册信息）
func (r *Registry) Start() {
	if r.publish == nil {
		return
	}

	// 立即注册一次
	r.broadcastRegistration()

	// 定期广播（每 30 秒）
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			r.broadcastRegistration()
		}
	}()
}

// broadcastRegistration 广播注册信息
func (r *Registry) broadcastRegistration() {
	if r.localPeerID == "" {
		return
	}

	reg := MatchNodeRegistration{
		PeerID:    r.localPeerID,
		Pairs:     r.localPairs,
		Capacity:  r.getCurrentCapacity(),
		Timestamp: time.Now().Unix(),
	}

	data, err := json.Marshal(reg)
	if err != nil {
		log.Printf("[registry] 序列化注册信息失败: %v", err)
		return
	}

	topic := "/p2p-exchange/match/register"
	if err := r.publish(topic, data); err != nil {
		log.Printf("[registry] 广播注册信息失败: %v", err)
		return
	}

	log.Printf("[registry] 广播注册信息 peerID=%s pairs=%v capacity=%d", r.localPeerID, r.localPairs, reg.Capacity)
}

// HandleRegistration 处理收到的注册消息
func (r *Registry) HandleRegistration(data []byte) {
	var reg MatchNodeRegistration
	if err := json.Unmarshal(data, &reg); err != nil {
		log.Printf("[registry] 解析注册信息失败: %v", err)
		return
	}

	// 忽略自己的注册信息
	if reg.PeerID == r.localPeerID {
		return
	}

	// 验证 PeerID 格式
	if _, err := peer.Decode(reg.PeerID); err != nil {
		log.Printf("[registry] 无效的 PeerID: %s", reg.PeerID)
		return
	}

	// 注册节点
	r.router.RegisterNode(reg.PeerID, reg.Pairs, reg.Capacity)
}

// getCurrentCapacity 获取当前负载（订单数）
func (r *Registry) getCurrentCapacity() int {
	// TODO: 从撮合引擎获取当前订单数
	// 暂时返回 0
	return 0
}

// UpdateCapacity 更新本地节点负载（由撮合引擎调用）
func (r *Registry) UpdateCapacity(capacity int) {
	// 立即广播更新
	r.broadcastRegistration()
}
