package match

import (
	"crypto/sha256"
	"encoding/hex"
	"log"
	"sync"
	"time"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// MatchNodeInfo 撮合节点信息
type MatchNodeInfo struct {
	PeerID    string   // libp2p PeerID
	Pairs     []string // 负责的交易对列表
	Capacity  int      // 当前负载（订单数）
	UpdatedAt int64    // 最后更新时间
}

// Router 订单路由：根据交易对选择目标撮合节点
type Router struct {
	mu          sync.RWMutex
	pairToNodes map[string][]string // pair -> []PeerID
	nodeInfo    map[string]*MatchNodeInfo // PeerID -> 节点信息
	localPeerID string              // 本地节点 PeerID
	localEngine *Engine             // 本地撮合引擎（如果本地负责该交易对）
}

// NewRouter 创建路由
func NewRouter(localPeerID string, localEngine *Engine) *Router {
	return &Router{
		pairToNodes: make(map[string][]string),
		nodeInfo:    make(map[string]*MatchNodeInfo),
		localPeerID: localPeerID,
		localEngine: localEngine,
	}
}

// RegisterNode 注册节点（收到节点注册消息时调用）
func (r *Router) RegisterNode(peerID string, pairs []string, capacity int) {
	if peerID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	// 更新节点信息
	r.nodeInfo[peerID] = &MatchNodeInfo{
		PeerID:    peerID,
		Pairs:     pairs,
		Capacity:  capacity,
		UpdatedAt: time.Now().Unix(),
	}

	// 更新交易对到节点的映射
	for _, pair := range pairs {
		if pair == "" {
			continue
		}
		// 检查是否已存在
		exists := false
		for _, existingPeerID := range r.pairToNodes[pair] {
			if existingPeerID == peerID {
				exists = true
				break
			}
		}
		if !exists {
			r.pairToNodes[pair] = append(r.pairToNodes[pair], peerID)
		}
	}

	log.Printf("[router] 注册节点 peerID=%s pairs=%v capacity=%d", peerID, pairs, capacity)
}

// SelectNode 选择目标节点（返回 PeerID，空字符串表示本地处理）
func (r *Router) SelectNode(pair string) (string, error) {
	if pair == "" {
		return "", nil
	}

	r.mu.RLock()
	defer r.mu.RUnlock()

	// 检查是否有专门负责该交易对的节点
	nodes, ok := r.pairToNodes[pair]
	if ok && len(nodes) > 0 {
		// 选择负载最低的节点
		return r.selectLowestLoad(nodes), nil
	}

	// 如果没有专门节点，使用哈希选择（用于默认路由）
	return r.selectByHash(pair), nil
}

// selectLowestLoad 选择负载最低的节点
func (r *Router) selectLowestLoad(peerIDs []string) string {
	if len(peerIDs) == 0 {
		return ""
	}

	// 过滤在线节点（最近 60 秒内更新）
	now := time.Now().Unix()
	onlineNodes := make([]string, 0)
	for _, peerID := range peerIDs {
		if info, ok := r.nodeInfo[peerID]; ok {
			if now-info.UpdatedAt < 60 {
				onlineNodes = append(onlineNodes, peerID)
			}
		}
	}

	if len(onlineNodes) == 0 {
		// 如果没有在线节点，使用哈希选择
		return r.selectByHashFromList(peerIDs)
	}

	// 选择负载最低的节点
	minLoad := -1
	selectedPeerID := onlineNodes[0]
	for _, peerID := range onlineNodes {
		info, ok := r.nodeInfo[peerID]
		if !ok {
			continue
		}
		if minLoad < 0 || info.Capacity < minLoad {
			minLoad = info.Capacity
			selectedPeerID = peerID
		}
	}

	return selectedPeerID
}

// selectByHash 使用哈希选择节点（用于默认路由）
func (r *Router) selectByHash(pair string) string {
	// 如果没有注册节点，返回空字符串（本地处理）
	if len(r.nodeInfo) == 0 {
		return ""
	}

	// 计算 pair 的哈希
	h := sha256.Sum256([]byte(pair))
	hashInt := 0
	for i := 0; i < 8; i++ {
		hashInt = hashInt<<8 | int(h[i])
	}

	// 选择节点
	peerIDs := make([]string, 0, len(r.nodeInfo))
	for peerID := range r.nodeInfo {
		peerIDs = append(peerIDs, peerID)
	}
	if len(peerIDs) == 0 {
		return ""
	}

	idx := hashInt % len(peerIDs)
	if idx < 0 {
		idx = -idx
	}
	return peerIDs[idx]
}

// selectByHashFromList 从指定列表中使用哈希选择
func (r *Router) selectByHashFromList(peerIDs []string) string {
	if len(peerIDs) == 0 {
		return ""
	}
	// 简单选择第一个（实际应该用哈希）
	return peerIDs[0]
}

// UpdateNodeCapacity 更新节点负载
func (r *Router) UpdateNodeCapacity(peerID string, capacity int) {
	if peerID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if info, ok := r.nodeInfo[peerID]; ok {
		info.Capacity = capacity
		info.UpdatedAt = time.Now().Unix()
	}
}

// RemoveNode 移除节点（节点离线时调用）
func (r *Router) RemoveNode(peerID string) {
	if peerID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	delete(r.nodeInfo, peerID)

	// 从交易对映射中移除
	for pair, nodes := range r.pairToNodes {
		newNodes := make([]string, 0)
		for _, n := range nodes {
			if n != peerID {
				newNodes = append(newNodes, n)
			}
		}
		r.pairToNodes[pair] = newNodes
	}

	log.Printf("[router] 移除节点 peerID=%s", peerID)
}

// RouteOrder 路由订单（返回是否需要转发，目标 PeerID，错误）
func (r *Router) RouteOrder(order *storage.Order) (needForward bool, targetPeerID string, err error) {
	if order == nil || order.Pair == "" {
		return false, "", nil
	}

	targetPeerID, err = r.SelectNode(order.Pair)
	if err != nil {
		return false, "", err
	}

	// 如果目标节点是本地节点或为空，本地处理
	if targetPeerID == "" || targetPeerID == r.localPeerID {
		return false, "", nil
	}

	return true, targetPeerID, nil
}

// IsLocalPair 检查交易对是否由本地节点负责
func (r *Router) IsLocalPair(pair string) bool {
	if pair == "" {
		return false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()

	// 检查本地节点是否在负责列表中
	for peerID, info := range r.nodeInfo {
		if peerID == r.localPeerID {
			for _, p := range info.Pairs {
				if p == pair {
					return true
				}
			}
		}
	}
	return false
}

// GetNodeInfo 获取节点信息（用于调试）
func (r *Router) GetNodeInfo(peerID string) *MatchNodeInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.nodeInfo[peerID]
}

// GetAllNodes 获取所有节点信息（用于调试）
func (r *Router) GetAllNodes() map[string]*MatchNodeInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	result := make(map[string]*MatchNodeInfo)
	for k, v := range r.nodeInfo {
		result[k] = &MatchNodeInfo{
			PeerID:    v.PeerID,
			Pairs:     append([]string{}, v.Pairs...),
			Capacity:  v.Capacity,
			UpdatedAt: v.UpdatedAt,
		}
	}
	return result
}

// CleanupStaleNodes 清理过期节点（超过 5 分钟未更新）
func (r *Router) CleanupStaleNodes() {
	now := time.Now().Unix()
	r.mu.Lock()
	defer r.mu.Unlock()

	for peerID, info := range r.nodeInfo {
		if now-info.UpdatedAt > 300 { // 5 分钟
			delete(r.nodeInfo, peerID)
			// 从交易对映射中移除
			for pair, nodes := range r.pairToNodes {
				newNodes := make([]string, 0)
				for _, n := range nodes {
					if n != peerID {
						newNodes = append(newNodes, n)
					}
				}
				r.pairToNodes[pair] = newNodes
			}
			log.Printf("[router] 清理过期节点 peerID=%s", peerID)
		}
	}
}

// GetPairHash 计算交易对的哈希（用于调试）
func GetPairHash(pair string) string {
	h := sha256.Sum256([]byte(pair))
	return hex.EncodeToString(h[:])
}
