package match

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"sort"
	"sync"
	"time"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// TopicSyncOrderbook compact level 快照广播主题（与 sync.TopicSyncOrderbook 一致）
const TopicSyncOrderbook = "/p2p-exchange/sync/orderbook"

// TopicOrderbookRequest 完整订单簿请求主题
const TopicOrderbookRequest = "/p2p-exchange/consensus/orderbook-request"

// OrderbookRequest 完整订单簿请求消息
type OrderbookRequest struct {
	Pair        string `json:"pair"`
	RequesterID string `json:"requesterId"`
}

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

// syncPair 同步单个交易对（§12.2 内存订单簿+增量：例行只发元数据，compact level 快照单独广播）
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

	if m.consensusEngine.isLeader() {
		// 例行同步：仅发元数据（hash/metadata），减少序列化与网络开销
		syncMsg := &OrderbookSync{
			Pair:         pair,
			SnapshotHash: snapshotHash,
			MerkleRoot:   snapshotHash,
			Bids:         nil, // 不随例行同步发送完整订单
			Asks:         nil,
			Timestamp:    time.Now().Unix(),
			LeaderID:     m.localPeerID,
		}
		data, err := json.Marshal(syncMsg)
		if err != nil {
			log.Printf("[sync] 序列化同步消息失败: %v", err)
		} else {
			topic := "/p2p-exchange/consensus/orderbook-sync"
			if err := m.publish(topic, data); err != nil {
				log.Printf("[sync] 广播同步消息失败: %v", err)
			}
		}

		// §12.2 compact level 快照：广播到 sync/orderbook，供显示/API 消费
		if snapshot := OrdersToLevelSnapshot(pair, bids, asks); snapshot != nil {
			snapData, err := json.Marshal(snapshot)
			if err == nil {
				_ = m.publish(TopicSyncOrderbook, snapData)
			}
		}
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

// applySync 应用同步数据（清单 1.2 订单簿状态不一致：收到 Leader 快照后替换本地订单簿）
func (m *OrderbookSyncManager) applySync(syncMsg *OrderbookSync) {
	if m.engine == nil {
		return
	}
	log.Printf("[sync] 应用同步数据 pair=%s bids=%d asks=%d", syncMsg.Pair, len(syncMsg.Bids), len(syncMsg.Asks))
	m.engine.ReplaceOrderbook(syncMsg.Pair, syncMsg.Bids, syncMsg.Asks)
	m.mu.Lock()
	m.syncedPairs[syncMsg.Pair] = true
	m.lastSyncTime[syncMsg.Pair] = time.Now().Unix()
	m.mu.Unlock()
}

// requestFullOrderbook 请求完整订单簿（发布到 orderbook-request，Leader 收到后回传完整 sync）
func (m *OrderbookSyncManager) requestFullOrderbook(pair string) {
	req := &OrderbookRequest{Pair: pair, RequesterID: m.localPeerID}
	data, err := json.Marshal(req)
	if err != nil {
		log.Printf("[sync] 序列化 orderbook 请求失败: %v", err)
		return
	}
	if err := m.publish(TopicOrderbookRequest, data); err != nil {
		log.Printf("[sync] 发布 orderbook 请求失败: %v", err)
		return
	}
	log.Printf("[sync] 已请求完整订单簿 pair=%s", pair)
}

// HandleOrderbookRequest 处理收到的 orderbook 请求（由主节点订阅 orderbook-request 后调用）
func (m *OrderbookSyncManager) HandleOrderbookRequest(req *OrderbookRequest) {
	if req == nil || req.Pair == "" {
		return
	}
	if !m.consensusEngine.isLeader() {
		return
	}
	bids, asks := m.engine.GetOrderbook(req.Pair)
	snapshotHash := m.calculateSnapshotHash(req.Pair, bids, asks)
	syncMsg := &OrderbookSync{
		Pair:         req.Pair,
		SnapshotHash: snapshotHash,
		MerkleRoot:   snapshotHash,
		Bids:         bids,
		Asks:         asks,
		Timestamp:    time.Now().Unix(),
		LeaderID:     m.localPeerID,
	}
	data, err := json.Marshal(syncMsg)
	if err != nil {
		return
	}
	topic := "/p2p-exchange/consensus/orderbook-sync"
	if err := m.publish(topic, data); err != nil {
		log.Printf("[sync] 回传完整订单簿失败: %v", err)
		return
	}
	log.Printf("[sync] 已回传完整订单簿 pair=%s bids=%d asks=%d", req.Pair, len(bids), len(asks))
}

// OrdersToLevelSnapshot 将订单列表聚合为 compact level 快照 [price, totalQty]（§12.2）
func OrdersToLevelSnapshot(pair string, bids, asks []*storage.Order) *storage.OrderbookSnapshot {
	if pair == "" {
		return nil
	}
	now := time.Now().Unix()
	snap := &storage.OrderbookSnapshot{Pair: pair, SnapshotAt: now}

	agg := func(orders []*storage.Order) []storage.OrderbookLevel {
		type level struct {
			price string
			qty   *big.Float
		}
		m := make(map[string]*big.Float)
		for _, o := range orders {
			if o == nil || o.Price == "" {
				continue
			}
			amt := bigNew(o.Amount)
			filled := bigNew(o.Filled)
			left := new(big.Float).Sub(amt, filled)
			if left.Cmp(big.NewFloat(0)) <= 0 {
				continue
			}
			if m[o.Price] == nil {
				m[o.Price] = new(big.Float)
			}
			m[o.Price].Add(m[o.Price], left)
		}
		var levels []level
		for p, q := range m {
			levels = append(levels, level{price: p, qty: q})
		}
		sort.Slice(levels, func(i, j int) bool {
			pi, pj := bigNew(levels[i].price), bigNew(levels[j].price)
			return pi.Cmp(pj) < 0
		})
		out := make([]storage.OrderbookLevel, 0, len(levels))
		for _, l := range levels {
			q := l.qty.Text('f', 18)
			out = append(out, storage.OrderbookLevel{l.price, q})
		}
		return out
	}

	// bids: 价格降序
	bidLevels := agg(bids)
	sort.Slice(bidLevels, func(i, j int) bool {
		pi, pj := bigNew(bidLevels[i][0]), bigNew(bidLevels[j][0])
		return pi.Cmp(pj) > 0
	})
	snap.Bids = bidLevels

	// asks: 价格升序
	askLevels := agg(asks)
	sort.Slice(askLevels, func(i, j int) bool {
		pi, pj := bigNew(askLevels[i][0]), bigNew(askLevels[j][0])
		return pi.Cmp(pj) < 0
	})
	snap.Asks = askLevels
	return snap
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
