package match

import (
	"strconv"
	"testing"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

func TestRestoreOrdersFromStore(t *testing.T) {
	dir := t.TempDir()
	store, err := storage.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	// 插入 open 订单
	o1 := &storage.Order{OrderID: "r1", Trader: "0x1", Pair: "TKA/TKB", Side: "buy", Price: "1", Amount: "100", Filled: "0", Status: "open", Nonce: 1, CreatedAt: 1, ExpiresAt: 0}
	o2 := &storage.Order{OrderID: "r2", Trader: "0x2", Pair: "TKA/TKB", Side: "sell", Price: "1.1", Amount: "50", Filled: "0", Status: "open", Nonce: 2, CreatedAt: 2, ExpiresAt: 0}
	if err := store.InsertOrder(o1); err != nil {
		t.Fatal(err)
	}
	if err := store.InsertOrder(o2); err != nil {
		t.Fatal(err)
	}

	engine := NewEngine(map[string]PairTokens{"TKA/TKB": {Token0: "0xa", Token1: "0xb"}})
	if err := RestoreOrdersFromStore(engine, store); err != nil {
		t.Fatal(err)
	}

	bids, asks := engine.GetOrderbook("TKA/TKB")
	if len(bids) != 1 || bids[0].OrderID != "r1" {
		t.Errorf("expected 1 bid r1, got %d bids %v", len(bids), bids)
	}
	if len(asks) != 1 || asks[0].OrderID != "r2" {
		t.Errorf("expected 1 ask r2, got %d asks %v", len(asks), asks)
	}
}

// TestRestoreOrdersFromStore_skipsFullyFilled 已全额成交却仍为 open 的订单
// （旧二进制下撮合后 Filled 从未回写）不得回簿；部分成交者按剩余量回簿。
func TestRestoreOrdersFromStore_skipsFullyFilled(t *testing.T) {
	dir := t.TempDir()
	store, err := storage.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	dead := &storage.Order{OrderID: "dead", Trader: "0x1", Pair: "TKA/TKB", Side: "sell", Price: "1", Amount: "100", Filled: "0", Status: "open", Nonce: 1, CreatedAt: 1, ExpiresAt: 0}
	partial := &storage.Order{OrderID: "part", Trader: "0x2", Pair: "TKA/TKB", Side: "sell", Price: "1", Amount: "100", Filled: "0", Status: "open", Nonce: 2, CreatedAt: 2, ExpiresAt: 0}
	if err := store.InsertOrder(dead); err != nil {
		t.Fatal(err)
	}
	if err := store.InsertOrder(partial); err != nil {
		t.Fatal(err)
	}
	// dead 已全额成交（成交表为准，与库内 Filled="0" 矛盾时以成交表为准）
	full := &storage.Trade{TradeID: "t-full", Pair: "TKA/TKB", MakerOrderID: "dead", TakerOrderID: "someone", Maker: "0x1", Taker: "0x3", TokenIn: "0xa", TokenOut: "0xb", Price: "1", Amount: "100.000000000000000000", Timestamp: 1700000000}
	if err := store.InsertTrade(full); err != nil {
		t.Fatal(err)
	}
	// part 只成交了 30
	part := &storage.Trade{TradeID: "t-part", Pair: "TKA/TKB", MakerOrderID: "part", TakerOrderID: "someone", Maker: "0x2", Taker: "0x3", TokenIn: "0xa", TokenOut: "0xb", Price: "1", Amount: "30.000000000000000000", Timestamp: 1700000000}
	if err := store.InsertTrade(part); err != nil {
		t.Fatal(err)
	}

	engine := NewEngine(map[string]PairTokens{"TKA/TKB": {Token0: "0xa", Token1: "0xb"}})
	if err := RestoreOrdersFromStore(engine, store); err != nil {
		t.Fatal(err)
	}
	_, asks := engine.GetOrderbook("TKA/TKB")
	if len(asks) != 1 || asks[0].OrderID != "part" {
		t.Fatalf("expected only partial ask restored, got %v", asks)
	}
	// 引擎入簿口径：剩余量折进 Amount、Filled 归零（AddOrder 的既有约定）
	if asks[0].Amount != "70.000000000000000000" {
		t.Errorf("partial ask amount = %q, want remaining 70", asks[0].Amount)
	}
	got, _ := store.GetOrder("dead")
	if got.Status != "filled" {
		t.Errorf("dead order status = %q, want filled", got.Status)
	}
}

func TestRestoreOrdersFromStore_nil(t *testing.T) {
	engine := NewEngine(nil)
	if err := RestoreOrdersFromStore(engine, nil); err != nil {
		t.Fatalf("RestoreOrdersFromStore(nil,nil) should return nil, got %v", err)
	}
}

// TestRestoreAndMatch 集成测试：storage 持久化 -> 恢复订单簿 -> 撮合 taker，验证成交
func TestRestoreAndMatch(t *testing.T) {
	dir := t.TempDir()
	store, err := storage.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	pairTokens := map[string]PairTokens{"TKA/TKB": {Token0: "0xa", Token1: "0xb"}}

	// 1. 插入 maker 卖单到 storage（模拟节点重启前持久化的订单）
	maker := &storage.Order{OrderID: "m1", Trader: "0x1", Pair: "TKA/TKB", Side: "sell", Price: "1.0", Amount: "100", Filled: "0", Status: "open", Nonce: 1, CreatedAt: 1, ExpiresAt: 0}
	if err := store.InsertOrder(maker); err != nil {
		t.Fatal(err)
	}

	// 2. 恢复订单簿
	engine := NewEngine(pairTokens)
	if err := RestoreOrdersFromStore(engine, store); err != nil {
		t.Fatal(err)
	}
	bids, asks := engine.GetOrderbook("TKA/TKB")
	if len(asks) != 1 || asks[0].OrderID != "m1" {
		t.Fatalf("restore: expected 1 ask m1, got bids=%d asks=%v", len(bids), asks)
	}

	// 3. 撮合 taker 买单（价格 1.0 可吃卖盘）
	taker := &storage.Order{OrderID: "t1", Trader: "0x2", Pair: "TKA/TKB", Side: "buy", Price: "1.0", Amount: "50", Filled: "0", Status: "open", Nonce: 2, CreatedAt: 2, ExpiresAt: 0}
	trades := engine.Match(taker)
	if len(trades) != 1 {
		t.Fatalf("expected 1 trade, got %d", len(trades))
	}
	tr := trades[0]
	if tr.MakerOrderID != "m1" || tr.TakerOrderID != "t1" {
		t.Errorf("trade ids: maker=%s taker=%s", tr.MakerOrderID, tr.TakerOrderID)
	}
	amt, _ := strconv.ParseFloat(tr.Amount, 64)
	if amt != 50 {
		t.Errorf("trade amount: %s (parsed=%.0f)", tr.Amount, amt)
	}
}
