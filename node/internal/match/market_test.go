package match

import (
	"math/big"
	"testing"
	"time"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// 市价单 IOC 语义测试（第十七轮，设计见 docs/market-orders.md）

func marketEngine() *Engine {
	e := NewEngine(map[string]PairTokens{
		"TKA/TKB": {Token0: "0xa", Token1: "0xb"},
	})
	e.EnsurePair("TKA/TKB")
	return e
}

func addAsk(e *Engine, id, price, amount string, createdAt int64) {
	o := &storage.Order{OrderID: id, Trader: "0xmaker", Pair: "TKA/TKB", Side: "sell", Price: price, Amount: amount, Filled: "0", Status: "open", CreatedAt: createdAt}
	if !e.AddOrder(o) {
		panic("AddOrder ask failed: " + id)
	}
}

func addBid(e *Engine, id, price, amount string, createdAt int64) {
	o := &storage.Order{OrderID: id, Trader: "0xmaker", Pair: "TKA/TKB", Side: "buy", Price: price, Amount: amount, Filled: "0", Status: "open", CreatedAt: createdAt}
	if !e.AddOrder(o) {
		panic("AddOrder bid failed: " + id)
	}
}

func marketOrder(side, price, amount string) *storage.Order {
	return &storage.Order{
		OrderID: "taker1", Trader: "0xtaker", Pair: "TKA/TKB", Side: side,
		Price: price, Amount: amount, Filled: "0", Status: "open",
		CreatedAt: 100, ExecType: storage.ExecTypeMarket,
	}
}

func eqFloat(t *testing.T, label, got string, want float64) {
	t.Helper()
	g, _ := bigNew(got).Float64()
	if g != want {
		t.Errorf("%s: got %s (=%v), want %v", label, got, g, want)
	}
}

// 逐档成交：两档卖盘按最优价顺序被吃，成交价为 maker 价（价格改善归 taker）
func TestMarketOrder_WalksLevels(t *testing.T) {
	e := marketEngine()
	addAsk(e, "a1", "2.0", "50", 1)
	addAsk(e, "a2", "2.1", "50", 2)

	exec := e.ExecuteMarketOrder(marketOrder("buy", "2.2", "80"))
	if len(exec.Trades) != 2 {
		t.Fatalf("expected 2 trades, got %d", len(exec.Trades))
	}
	eqFloat(t, "trade0 price", exec.Trades[0].Price, 2.0)
	eqFloat(t, "trade0 amount", exec.Trades[0].Amount, 50)
	eqFloat(t, "trade1 price", exec.Trades[1].Price, 2.1)
	eqFloat(t, "trade1 amount", exec.Trades[1].Amount, 30)
	eqFloat(t, "executed", exec.Executed, 80)
	eqFloat(t, "remainder", exec.Remainder, 0)
	if !exec.FullyFilled {
		t.Error("expected FullyFilled")
	}
	// 第二档应剩 20
	_, asks := e.GetOrderbook("TKA/TKB")
	if len(asks) != 1 {
		t.Fatalf("expected 1 ask left, got %d", len(asks))
	}
	left := newFloatSub(asks[0].Amount, asks[0].Filled)
	eqFloat(t, "ask remaining", left, 20)
}

// 部分成交：盘口深度不足时余量不入簿（IOC），taker 不出现在买盘
func TestMarketOrder_PartialRemainderNotBooked(t *testing.T) {
	e := marketEngine()
	addAsk(e, "a1", "2.0", "30", 1)

	exec := e.ExecuteMarketOrder(marketOrder("buy", "2.5", "100"))
	if len(exec.Trades) != 1 {
		t.Fatalf("expected 1 trade, got %d", len(exec.Trades))
	}
	eqFloat(t, "executed", exec.Executed, 30)
	eqFloat(t, "remainder", exec.Remainder, 70)
	if exec.FullyFilled {
		t.Error("expected not FullyFilled")
	}
	bids, asks := e.GetOrderbook("TKA/TKB")
	if len(bids) != 0 {
		t.Errorf("market taker must never rest in the book, got %d bids", len(bids))
	}
	if len(asks) != 0 {
		t.Errorf("expected asks consumed, got %d", len(asks))
	}
}

// 保护价止步：越过保护价的档位不成交、保留在盘口
func TestMarketOrder_ProtectionPriceStops(t *testing.T) {
	e := marketEngine()
	addAsk(e, "a1", "2.0", "10", 1)
	addAsk(e, "a2", "3.0", "10", 2)

	exec := e.ExecuteMarketOrder(marketOrder("buy", "2.5", "20"))
	if len(exec.Trades) != 1 {
		t.Fatalf("expected 1 trade, got %d", len(exec.Trades))
	}
	eqFloat(t, "executed", exec.Executed, 10)
	eqFloat(t, "remainder", exec.Remainder, 10)
	_, asks := e.GetOrderbook("TKA/TKB")
	if len(asks) != 1 || asks[0].OrderID != "a2" {
		t.Errorf("expected only a2 left in asks, got %v", asks)
	}
}

// 空盘口：零成交、零余量消耗，HasOppositeLiquidity 与预检口径一致
func TestMarketOrder_EmptyBook(t *testing.T) {
	e := marketEngine()
	if e.HasOppositeLiquidity("TKA/TKB", "buy") {
		t.Error("empty book must report no opposite liquidity for buy")
	}
	exec := e.ExecuteMarketOrder(marketOrder("buy", "2.5", "10"))
	if len(exec.Trades) != 0 {
		t.Fatalf("expected no trades, got %d", len(exec.Trades))
	}
	eqFloat(t, "executed", exec.Executed, 0)
	eqFloat(t, "remainder", exec.Remainder, 10)

	addAsk(e, "a1", "2.0", "10", 1)
	if !e.HasOppositeLiquidity("TKA/TKB", "buy") {
		t.Error("expected opposite liquidity after ask added")
	}
	if e.HasOppositeLiquidity("TKA/TKB", "sell") {
		t.Error("no bids: sell side must report no opposite liquidity")
	}
}

// 卖向对称：吃买盘最高档，余量不入簿
func TestMarketOrder_SellSide(t *testing.T) {
	e := marketEngine()
	addBid(e, "b1", "2.0", "40", 1)

	exec := e.ExecuteMarketOrder(marketOrder("sell", "1.9", "50"))
	if len(exec.Trades) != 1 {
		t.Fatalf("expected 1 trade, got %d", len(exec.Trades))
	}
	eqFloat(t, "trade price", exec.Trades[0].Price, 2.0)
	eqFloat(t, "executed", exec.Executed, 40)
	eqFloat(t, "remainder", exec.Remainder, 10)
	bids, asks := e.GetOrderbook("TKA/TKB")
	if len(asks) != 0 {
		t.Errorf("market sell taker must never rest in the book, got %d asks", len(asks))
	}
	if len(bids) != 0 {
		t.Errorf("expected bids consumed, got %d", len(bids))
	}
}

// 已过期市价单不执行
func TestMarketOrder_ExpiredNotExecuted(t *testing.T) {
	e := marketEngine()
	addAsk(e, "a1", "2.0", "10", 1)
	o := marketOrder("buy", "2.5", "10")
	o.ExpiresAt = time.Now().Unix() - 10
	exec := e.ExecuteMarketOrder(o)
	if len(exec.Trades) != 0 {
		t.Fatalf("expired market order must not execute, got %d trades", len(exec.Trades))
	}
	eqFloat(t, "executed", exec.Executed, 0)
}

func newFloatSub(a, b string) string {
	f := new(big.Float).Sub(bigNew(a), bigNew(b))
	return f.Text('f', 18)
}
