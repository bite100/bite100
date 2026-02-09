package sync

import (
	"encoding/json"
	"log"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// Phase 3.1 Gossip 主题（与 Phase3-设计文档 §2.5、技术架构说明 §3.3 对齐）
const (
	TopicOrderNew      = "/p2p-exchange/order/new"
	TopicOrderCancel   = "/p2p-exchange/order/cancel"
	TopicTradeExecuted = "/p2p-exchange/trade/executed"
	TopicSyncOrderbook = "/p2p-exchange/sync/orderbook"
	TopicMatchRegister = "/p2p-exchange/match/register" // 方案 B：节点注册
)

// CancelRequest 撤单请求（orderId + signature + timestamp）
type CancelRequest struct {
	OrderID   string `json:"orderId"`
	Signature string `json:"signature,omitempty"`
	Timestamp int64  `json:"timestamp,omitempty"` // 签名时间戳
}

// ParseOrderNew 解析 /order/new 消息为 Order
func ParseOrderNew(data []byte) (*storage.Order, error) {
	var o storage.Order
	if err := json.Unmarshal(data, &o); err != nil {
		return nil, err
	}
	return &o, nil
}

// ParseOrderCancel 解析 /order/cancel 消息
func ParseOrderCancel(data []byte) (*CancelRequest, error) {
	var c CancelRequest
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

// ParseTradeExecuted 解析 /trade/executed 消息为 Trade（与 storage.Trade 一致）
func ParseTradeExecuted(data []byte) (*storage.Trade, error) {
	var t storage.Trade
	if err := json.Unmarshal(data, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

// ParseOrderbookSnapshot 解析 /sync/orderbook 快照消息
func ParseOrderbookSnapshot(data []byte) (*storage.OrderbookSnapshot, error) {
	var s storage.OrderbookSnapshot
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// PersistOrderNew 存储节点：持久化新订单（已过期订单不写入，Replay/过期防护）
func PersistOrderNew(store *storage.DB, data []byte) {
	o, err := ParseOrderNew(data)
	if err != nil {
		log.Printf("[order/new] 解析失败: %v", err)
		return
	}
	if storage.OrderExpired(o) {
		log.Printf("[order/new] 已过期，跳过 orderId=%s expiresAt=%d", o.OrderID, o.ExpiresAt)
		return
	}
	if err := store.InsertOrder(o); err != nil {
		log.Printf("[order/new] 写入失败: %v", err)
		return
	}
	log.Printf("[order/new] 已持久化 orderId=%s pair=%s", o.OrderID, o.Pair)
}

// PersistOrderCancel 存储节点：更新订单状态为 cancelled（若本地有该订单）
func PersistOrderCancel(store *storage.DB, data []byte) {
	c, err := ParseOrderCancel(data)
	if err != nil {
		log.Printf("[order/cancel] 解析失败: %v", err)
		return
	}
	existing, err := store.GetOrder(c.OrderID)
	if err != nil || existing == nil {
		log.Printf("[order/cancel] 本地无该订单 orderId=%s，跳过", c.OrderID)
		return
	}
	if err := store.UpdateOrderStatus(c.OrderID, "cancelled", existing.Filled); err != nil {
		log.Printf("[order/cancel] 更新失败: %v", err)
		return
	}
	log.Printf("[order/cancel] 已撤单 orderId=%s", c.OrderID)
}

// PersistTradeExecuted 存储节点：持久化成交
func PersistTradeExecuted(store *storage.DB, data []byte) {
	t, err := ParseTradeExecuted(data)
	if err != nil {
		log.Printf("[trade/executed] 解析失败: %v", err)
		return
	}
	if err := store.InsertTrade(t); err != nil {
		log.Printf("[trade/executed] 写入失败: %v", err)
		return
	}
	log.Printf("[trade/executed] 已持久化 tradeId=%s pair=%s", t.TradeID, t.Pair)
}

// PersistOrderbookSnapshot 存储节点：持久化订单簿快照
func PersistOrderbookSnapshot(store *storage.DB, data []byte) {
	s, err := ParseOrderbookSnapshot(data)
	if err != nil {
		log.Printf("[sync/orderbook] 解析快照失败: %v", err)
		return
	}
	if err := store.InsertSnapshot(s); err != nil {
		log.Printf("[sync/orderbook] 写入快照失败: %v", err)
		return
	}
	log.Printf("[sync/orderbook] 已持久化快照 pair=%s snapshotAt=%d", s.Pair, s.SnapshotAt)
}
