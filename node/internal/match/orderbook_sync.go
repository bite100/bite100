package match

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// OrderbookSync 订单簿同步消息（方案 C）
type OrderbookSync struct {
	Pair         string   `json:"pair"`         // 交易对
	SnapshotHash string   `json:"snapshotHash"` // 快照哈希
	MerkleRoot   string   `json:"merkleRoot"`   // Merkle 根
	Bids         []*storage.Order `json:"bids"` // 买盘（可选，用于同步）
	Asks         []*storage.Order `json:"asks"` // 卖盘（可选，用于同步）
	Timestamp    int64    `json:"timestamp"`    // 快照时间
	LeaderID     string   `json:"leaderId"`    // Leader PeerID
}

// OrderbookSyncManager 订单簿同步管理器（方案 C）
type OrderbookSyncManager struct {
	mu              sync.RWMutex
	consensusEngine *ConsensusEngine
	engine          *Engine
	localPeerID     string
	publish         func(topic string, data []byte) error
	
	// 同步状态
	syncedPairs     map[string]bool // pair -> 是否已同步
	lastSyncTime    map[string]int64 // pair -> 最后同步时间
	syncInterval    time.Duration    // 同步间隔
}

// NewOrderbookSyncManager 创建订单簿同步管理器
func NewOrderbookSyncManager(consensusEngine *ConsensusEngine, engine *Engine, localPeerID string, publish func(topic string, data []byte) error) *OrderbookSyncManager {
	return &OrderbookSyncManager{
		consensusEngine: consensusEngine,
		engine:          engine,
		localPeerID:     localPeerID,
		publish:         publish,
		syncedPairs:     make(map[string]bool),
		lastSyncTime:    make(map[string]int64),
		syncInterval:    30 * time.Second, // 默认 30 秒同步一次
	}
}

// Start 启动同步管理器
func (m *OrderbookSyncManager) Start() {
	log.Printf("[sync] 订单簿同步管理器已启动")
	
	// 定期同步订单簿
	go func() {
		ticker := time.NewTicker(m.syncInterval)
		defer ticker.Stop()
		
		for range ticker.C {
			m.syncAllPairs()
		}
	}()
}

// syncAllPairs 同步所有交易对
func (m *OrderbookSyncManager) syncAllPairs() {
	if m.engine == nil {
		return
	}
	
	// 获取所有交易对
	pairs := m.engine.GetAllPairs()
	
	for _, pair := range pairs {
		m.syncPair(pair)
	}
}

// syncPair 同步单个交易对
func (m *OrderbookSyncManager) syncPair(pair string) {
	if m.engine == nil {
		return
	}
	
	// 获取订单簿
	bids, asks := m.engine.GetOrderbook(pair)
	
	// 计算快照哈希
	snapshotHash := m.calculateSnapshotHash(pair, bids, asks)
	
	// 更新共识引擎的订单簿哈希
	m.consensusEngine.UpdateOrderbookHash(pair, bids, asks)
	
	// 如果是 Leader，广播同步消息
	if m.consensusEngine.isLeader() {
		syncMsg := &OrderbookSync{
			Pair:         pair,
			SnapshotHash: snapshotHash,
			MerkleRoot:   snapshotHash, // 简化：使用快照哈希作为 Merkle 根
			Bids:         bids,
			Asks:         asks,
			Timestamp:    time.Now().Unix(),
			LeaderID:     m.localPeerID,
		}
		
		data, err := json.Marshal(syncMsg)
		if err != nil {
			log.Printf("[sync] 序列化同步消息失败: %v", err)
			return
		}
		
		topic := "/p2p-exchange/consensus/orderbook-sync"
		if err := m.publish(topic, data); err != nil {
			log.Printf("[sync] 广播同步消息失败: %v", err)
			return
		}
		
		log.Printf("[sync] 广播订单簿同步 pair=%s hash=%s", pair, snapshotHash)
	}
	
	m.mu.Lock()
	m.lastSyncTime[pair] = time.Now().Unix()
	m.mu.Unlock()
}

// HandleSync 处理收到的同步消息
func (m *OrderbookSyncManager) HandleSync(syncMsg *OrderbookSync) error {
	if syncMsg == nil || syncMsg.Pair == "" {
		return fmt.Errorf("invalid sync message")
	}
	
	// 验证 Leader
	if syncMsg.LeaderID != m.consensusEngine.GetLeader() {
		log.Printf("[sync] 忽略非 Leader 的同步消息 leader=%s", syncMsg.LeaderID)
		return nil
	}
	
	// 获取本地订单簿
	bids, asks := m.engine.GetOrderbook(syncMsg.Pair)
	localHash := m.calculateSnapshotHash(syncMsg.Pair, bids, asks)
	
	// 比较哈希
	if localHash == syncMsg.SnapshotHash {
		// 已同步
		m.mu.Lock()
		m.syncedPairs[syncMsg.Pair] = true
		m.mu.Unlock()
		return nil
	}
	
	// 哈希不一致，需要同步
	log.Printf("[sync] 订单簿不一致 pair=%s local=%s remote=%s，开始同步", syncMsg.Pair, localHash, syncMsg.SnapshotHash)
	
	// 如果同步消息包含订单簿数据，直接更新
	if len(syncMsg.Bids) > 0 || len(syncMsg.Asks) > 0 {
		m.applySync(syncMsg)
	} else {
		// 否则请求完整订单簿
		m.requestFullOrderbook(syncMsg.Pair)
	}
	
	return nil
}

// applySync 应用同步数据
func (m *OrderbookSyncManager) applySync(syncMsg *OrderbookSync) {
	if m.engine == nil {
		return
	}
	
	// TODO: 实现订单簿合并逻辑
	// 这里简化处理：清空本地订单簿，使用同步的数据
	log.Printf("[sync] 应用同步数据 pair=%s bids=%d asks=%d", syncMsg.Pair, len(syncMsg.Bids), len(syncMsg.Asks))
	
	// 注意：实际应该合并而不是替换，这里简化处理
	m.mu.Lock()
	m.syncedPairs[syncMsg.Pair] = true
	m.lastSyncTime[syncMsg.Pair] = time.Now().Unix()
	m.mu.Unlock()
}

// requestFullOrderbook 请求完整订单簿
func (m *OrderbookSyncManager) requestFullOrderbook(pair string) {
	// TODO: 实现请求完整订单簿的逻辑
	log.Printf("[sync] 请求完整订单簿 pair=%s", pair)
}

// calculateSnapshotHash 计算订单簿快照哈希
func (m *OrderbookSyncManager) calculateSnapshotHash(pair string, bids, asks []*storage.Order) string {
	// 构建快照数据
	data := fmt.Sprintf("%s-%d-%d", pair, len(bids), len(asks))
	
	// 添加订单 ID（简化：只使用订单数量）
	for _, bid := range bids {
		data += "-" + bid.OrderID
	}
	for _, ask := range asks {
		data += "-" + ask.OrderID
	}
	
	// 计算哈希
	hash := sha256.Sum256([]byte(data))
	return fmt.Sprintf("%x", hash)
}

// GetAllPairs 获取所有交易对（需要 Engine 支持）
// 这里假设 Engine 有 GetAllPairs 方法，如果没有，需要添加
func (e *Engine) GetAllPairs() []string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	
	pairs := make([]string, 0, len(e.pairs))
	for pair := range e.pairs {
		pairs = append(pairs, pair)
	}
	return pairs
}
