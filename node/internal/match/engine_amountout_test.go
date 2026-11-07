package match

import (
	"testing"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// 第二十九轮回归：成交记录的对手币数量必须按统一公式 qty × price / 1e18
// 派生（与 BuildSignedOrder/DeriveAmountOut 逐位一致）。修复前引擎用浮点
// qty×price 漏除 1e18，AmountOut（买向）/AmountIn（卖向）被放大 1e18 倍，
// 且高位价格下浮点 64 位尾数把数量尾数磨成乱码。用 BTC/USDT 量级的
// 价格/数量锁定口径：0.01 BTC @ 75,696.05 → 对手币 756.9605 USDT。
func TestMatchAmountOutUsesCanonicalDerivation(t *testing.T) {
	pairTokens := map[string]PairTokens{
		"BTC/USDT": {Token0: "0xbtc", Token1: "0xusdt"},
	}
	const (
		qtyWei   = "10000000000000000"       // 0.01 BTC（最小单位）
		priceWei = "75696050000000000000000" // 75,696.05（1e18 定点）
		quoteWei = "756960500000000000000.000000000000000000"
		baseWei  = "10000000000000000.000000000000000000"
	)

	// 买向：taker 买单吃 maker 卖单 → AmountIn=Token0 量，AmountOut=对手币量
	e := NewEngine(pairTokens)
	e.EnsurePair("BTC/USDT")
	ask := &storage.Order{OrderID: "ask1", Trader: "0xmaker", Pair: "BTC/USDT", Side: "sell", Price: priceWei, Amount: qtyWei, Filled: "0", Status: "open", CreatedAt: 1}
	if !e.AddOrder(ask) {
		t.Fatal("AddOrder ask failed")
	}
	buy := &storage.Order{OrderID: "buy1", Trader: "0xtaker", Pair: "BTC/USDT", Side: "buy", Price: priceWei, Amount: qtyWei, Filled: "0", Status: "open", CreatedAt: 2}
	trades := e.Match(buy)
	if len(trades) != 1 {
		t.Fatalf("buy match: got %d trades, want 1", len(trades))
	}
	if trades[0].AmountIn != baseWei {
		t.Errorf("buy AmountIn = %s, want %s", trades[0].AmountIn, baseWei)
	}
	if trades[0].AmountOut != quoteWei {
		t.Errorf("buy AmountOut = %s, want %s（qty×price/1e18；漏除 1e18 会放大 1e18 倍）", trades[0].AmountOut, quoteWei)
	}

	// 卖向：taker 卖单吃 maker 买单 → AmountIn=对手币量，AmountOut=Token0 量
	e2 := NewEngine(pairTokens)
	e2.EnsurePair("BTC/USDT")
	bid := &storage.Order{OrderID: "bid1", Trader: "0xmaker", Pair: "BTC/USDT", Side: "buy", Price: priceWei, Amount: qtyWei, Filled: "0", Status: "open", CreatedAt: 1}
	if !e2.AddOrder(bid) {
		t.Fatal("AddOrder bid failed")
	}
	sell := &storage.Order{OrderID: "sell1", Trader: "0xtaker", Pair: "BTC/USDT", Side: "sell", Price: priceWei, Amount: qtyWei, Filled: "0", Status: "open", CreatedAt: 2}
	trades2 := e2.Match(sell)
	if len(trades2) != 1 {
		t.Fatalf("sell match: got %d trades, want 1", len(trades2))
	}
	if trades2[0].AmountIn != quoteWei {
		t.Errorf("sell AmountIn = %s, want %s（qty×price/1e18）", trades2[0].AmountIn, quoteWei)
	}
	if trades2[0].AmountOut != baseWei {
		t.Errorf("sell AmountOut = %s, want %s", trades2[0].AmountOut, baseWei)
	}
}
