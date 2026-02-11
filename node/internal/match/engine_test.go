package match

import (
	"testing"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

func TestReplaceOrderbook(t *testing.T) {
	pairTokens := map[string]PairTokens{
		"TKA/TKB": {Token0: "0xa", Token1: "0xb"},
	}
	e := NewEngine(pairTokens)
	e.EnsurePair("TKA/TKB")

	// 添加初始订单
	bid1 := &storage.Order{OrderID: "b1", Trader: "0x1", Pair: "TKA/TKB", Side: "buy", Price: "1", Amount: "100", Filled: "0", Status: "open", CreatedAt: 1, ExpiresAt: 0}
	ask1 := &storage.Order{OrderID: "a1", Trader: "0x2", Pair: "TKA/TKB", Side: "sell", Price: "1", Amount: "50", Filled: "0", Status: "open", CreatedAt: 2, ExpiresAt: 0}
	if !e.AddOrder(bid1) {
		t.Fatal("AddOrder bid1 failed")
	}
	if !e.AddOrder(ask1) {
		t.Fatal("AddOrder ask1 failed")
	}

	// 用 ReplaceOrderbook 替换
	newBids := []*storage.Order{
		{OrderID: "b2", Trader: "0x3", Pair: "TKA/TKB", Side: "buy", Price: "0.9", Amount: "200", Filled: "0", Status: "open", CreatedAt: 3, ExpiresAt: 0},
	}
	newAsks := []*storage.Order{
		{OrderID: "a2", Trader: "0x4", Pair: "TKA/TKB", Side: "sell", Price: "1.1", Amount: "100", Filled: "0", Status: "open", CreatedAt: 4, ExpiresAt: 0},
	}
	e.ReplaceOrderbook("TKA/TKB", newBids, newAsks)

	bids, asks := e.GetOrderbook("TKA/TKB")
	if len(bids) != 1 || bids[0].OrderID != "b2" {
		t.Errorf("expected 1 bid b2, got %d bids %v", len(bids), bids)
	}
	if len(asks) != 1 || asks[0].OrderID != "a2" {
		t.Errorf("expected 1 ask a2, got %d asks %v", len(asks), asks)
	}
}

func TestEpochID(t *testing.T) {
	if id := EpochID(100, 30); id != 3 {
		t.Errorf("EpochID(100,30)=%d want 3", id)
	}
	if id := EpochID(89, 30); id != 2 {
		t.Errorf("EpochID(89,30)=%d want 2", id)
	}
}

func TestMatchBatch(t *testing.T) {
	pairTokens := map[string]PairTokens{
		"TKA/TKB": {Token0: "0xa", Token1: "0xb"},
	}
	e := NewEngine(pairTokens)
	e.EnsurePair("TKA/TKB")
	// maker 卖 100@1
	ask := &storage.Order{OrderID: "m1", Trader: "0x2", Pair: "TKA/TKB", Side: "sell", Price: "1", Amount: "100", Filled: "0", Status: "open", CreatedAt: 1, ExpiresAt: 0}
	if !e.AddOrder(ask) {
		t.Fatal("AddOrder ask failed")
	}
	// 两笔 taker 买，CreatedAt 不同
	t1 := &storage.Order{OrderID: "t1", Trader: "0x1", Pair: "TKA/TKB", Side: "buy", Price: "1", Amount: "30", Filled: "0", Status: "open", CreatedAt: 10, ExpiresAt: 0}
	t2 := &storage.Order{OrderID: "t2", Trader: "0x1", Pair: "TKA/TKB", Side: "buy", Price: "1", Amount: "40", Filled: "0", Status: "open", CreatedAt: 5, ExpiresAt: 0}
	// MatchBatch 按 CreatedAt 升序，t2(5) 先于 t1(10)
	trades := e.MatchBatch([]*storage.Order{t1, t2})
	if len(trades) != 2 {
		t.Fatalf("expected 2 trades, got %d", len(trades))
	}
	// t2 先撮合 -> t2-m1-1
	if trades[0].TakerOrderID != "t2" {
		t.Errorf("first trade taker want t2 got %s", trades[0].TakerOrderID)
	}
	if trades[1].TakerOrderID != "t1" {
		t.Errorf("second trade taker want t1 got %s", trades[1].TakerOrderID)
	}
}

func TestMatchDeterministicTradeID(t *testing.T) {
	pairTokens := map[string]PairTokens{
		"TKA/TKB": {Token0: "0xa", Token1: "0xb"},
	}
	e := NewEngine(pairTokens)
	e.EnsurePair("TKA/TKB")

	// 添加 maker 卖单
	ask := &storage.Order{OrderID: "maker1", Trader: "0x2", Pair: "TKA/TKB", Side: "sell", Price: "1", Amount: "100", Filled: "0", Status: "open", CreatedAt: 1, ExpiresAt: 0}
	if !e.AddOrder(ask) {
		t.Fatal("AddOrder ask failed")
	}

	// taker 买单
	taker := &storage.Order{OrderID: "taker1", Trader: "0x1", Pair: "TKA/TKB", Side: "buy", Price: "1", Amount: "50", Filled: "0", Status: "open", CreatedAt: 2, ExpiresAt: 0}

	trades := e.Match(taker)
	if len(trades) != 1 {
		t.Fatalf("expected 1 trade, got %d", len(trades))
	}
	// 确定性 TradeID 格式：takerOrderID-makerOrderID-seq
	expectedPrefix := "taker1-maker1-1"
	if trades[0].TradeID != expectedPrefix {
		t.Errorf("expected TradeID %q, got %q", expectedPrefix, trades[0].TradeID)
	}
}
