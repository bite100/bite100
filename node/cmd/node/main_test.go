package main

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/P2P-P2P/p2p/node/internal/match"
	"github.com/P2P-P2P/p2p/node/internal/settlement"
	"github.com/P2P-P2P/p2p/node/internal/storage"
	"github.com/P2P-P2P/p2p/node/internal/sync"
)

// 第二十九轮回归（问题 1）：已成交订单在节点库里必须双腿状态一致。
// 修复前 processOrderLocally 在撮合后才 InsertOrder 本单，INSERT OR REPLACE
// 把 recordTrade/RecomputeOrderFill 刚回写的成交量覆盖回初始值——本单
// （taker 腿）恒显示 open/0（第 27 轮 E2E 的 countersell 即如此）。
func TestProcessOrderLocallyBothLegsFilled(t *testing.T) {
	store, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	pairs := map[string]match.PairTokens{"TKA/TKB": {Token0: "0xa", Token1: "0xb"}}
	h := &orderMatchHandler{
		engine:    match.NewEngine(pairs),
		publisher: &sync.OrderPublisher{},
		store:     store,
	}
	now := time.Now().Unix()
	const (
		price  = "2000000000000000000"  // 2.0
		amount = "10000000000000000000" // 10 TKA
	)
	maker := &storage.Order{OrderID: "m-sell", Trader: "0xmaker", Pair: "TKA/TKB", Side: "sell", Price: price, Amount: amount, Filled: "0", Status: "open", CreatedAt: now, ExpiresAt: now + 86400}
	if err := h.processOrderLocally(maker); err != nil {
		t.Fatal(err)
	}
	taker := &storage.Order{OrderID: "t-buy", Trader: "0xtaker", Pair: "TKA/TKB", Side: "buy", Price: price, Amount: amount, Filled: "0", Status: "open", CreatedAt: now, ExpiresAt: now + 86400}
	if err := h.processOrderLocally(taker); err != nil {
		t.Fatal(err)
	}
	wantFilled := amount + ".000000000000000000"
	for _, id := range []string{"m-sell", "t-buy"} {
		o, err := store.GetOrder(id)
		if err != nil || o == nil {
			t.Fatalf("订单 %s 读取失败: %v", id, err)
		}
		if o.Status != "filled" || o.Filled != wantFilled {
			t.Errorf("订单 %s: status=%q filled=%q, want filled/%s（成交后双腿须一致回写）", id, o.Status, o.Filled, wantFilled)
		}
	}
}

// 部分成交：maker 腿 partial 且 filled 精确，taker 腿 filled。
func TestProcessOrderLocallyPartialFillConsistency(t *testing.T) {
	store, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	pairs := map[string]match.PairTokens{"TKA/TKB": {Token0: "0xa", Token1: "0xb"}}
	h := &orderMatchHandler{
		engine:    match.NewEngine(pairs),
		publisher: &sync.OrderPublisher{},
		store:     store,
	}
	now := time.Now().Unix()
	const price = "2000000000000000000"
	maker := &storage.Order{OrderID: "m-sell10", Trader: "0xmaker", Pair: "TKA/TKB", Side: "sell", Price: price, Amount: "10000000000000000000", Filled: "0", Status: "open", CreatedAt: now, ExpiresAt: now + 86400}
	if err := h.processOrderLocally(maker); err != nil {
		t.Fatal(err)
	}
	taker := &storage.Order{OrderID: "t-buy4", Trader: "0xtaker", Pair: "TKA/TKB", Side: "buy", Price: price, Amount: "4000000000000000000", Filled: "0", Status: "open", CreatedAt: now, ExpiresAt: now + 86400}
	if err := h.processOrderLocally(taker); err != nil {
		t.Fatal(err)
	}
	mo, _ := store.GetOrder("m-sell10")
	if mo.Status != "partial" || mo.Filled != "4000000000000000000.000000000000000000" {
		t.Errorf("maker: status=%q filled=%q, want partial/4e18", mo.Status, mo.Filled)
	}
	to, _ := store.GetOrder("t-buy4")
	if to.Status != "filled" || to.Filled != "4000000000000000000.000000000000000000" {
		t.Errorf("taker: status=%q filled=%q, want filled/4e18", to.Status, to.Filled)
	}
}

// 第二十九轮（问题 5）：落锁结果分类——pending 必须是在途而非拒单，
// 与 lock.go「不得按失败处理」的契约对齐（含 %w 包装的情形）。
func TestClassifyLockErr(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want lockVerdict
	}{
		{"nil 成功", nil, lockOK},
		{"pending 在途", fmt.Errorf("%w: 0xabc", settlement.ErrTxPending), lockTrack},
		{"dropped 重驱", fmt.Errorf("%w: 0xabc", settlement.ErrTxDropped), lockRedrive},
		{"确定性失败", errors.New("vault: insufficient available balance"), lockReject},
	}
	for _, c := range cases {
		if got := classifyLockErr(c.err); got != c.want {
			t.Errorf("%s: classifyLockErr(%v) = %d, want %d", c.name, c.err, got, c.want)
		}
	}
}
