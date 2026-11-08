package match

import (
	"testing"
	"time"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// 第 34 轮 M1（第 33 轮复审新发现）：AddOrder 的同 ID 替换必须原子。
// 上一版先 removeOrderFromBook 再 checkInsertable：同 pair 跨侧替换
// （卖→买）且目标侧满员时，旧单已从对侧删除、新单又被容量拒绝，一笔
// 有效挂单被静默销毁。修复后动簿前按「移除旧单后的目标侧容量」预判，
// 拒绝即零副作用。

func r34Order(id, pair, side string, created int64, price string) *storage.Order {
	o := r33Order(id, pair, side, created, created+3600)
	if price != "" {
		o.Price = price
	}
	return o
}

const r34Pair = "TKA/TKB"

// 边界一：跨侧替换 + 目标侧满员 → 拒绝且旧单原样留簿、索引不动、
// 目标侧簿面分毫未动。
func TestAddOrder_CrossSideReplaceIntoFullSide_KeepsOldOrder(t *testing.T) {
	e := NewEngine(nil)
	e.maxOrdersPerPair = 2
	now := time.Now().Unix()

	// 旧单：卖单 s1（价格 5e17，便于事后辨认）。
	if !e.AddOrder(r34Order("s1", r34Pair, "sell", now, "500000000000000000")) {
		t.Fatal("AddOrder(s1 sell) = false, want true")
	}
	// 目标侧（买盘）装满。
	for i, id := range []string{"b1", "b2"} {
		if !e.AddOrder(r34Order(id, r34Pair, "buy", now+int64(i), "")) {
			t.Fatalf("AddOrder(%s buy) = false, want true", id)
		}
	}

	// 同 ID 跨侧替换为买单 → 目标侧满员，必须拒绝。
	if e.AddOrder(r34Order("s1", r34Pair, "buy", now+10, "")) {
		t.Fatal("AddOrder(s1 buy, bids full) = true, want false (atomic reject)")
	}
	bids, asks := e.GetOrderbook(r34Pair)
	if len(asks) != 1 || asks[0].OrderID != "s1" || asks[0].Price != "500000000000000000" {
		t.Errorf("old sell order must survive failed cross-side replacement, asks = %+v", asks)
	}
	if len(bids) != 2 {
		t.Errorf("bids must be untouched, len = %d", len(bids))
	}
	if e.orderIDToPair["s1"] != r34Pair {
		t.Error("index for s1 must stay after failed cross-side replacement")
	}
}

// 边界二：同侧替换 + 本侧满员 → 移除旧单腾位后成功（承第 32 轮口径），
// 簿长不变、新单生效、索引保留。
func TestAddOrder_SameSideReplaceAtCapacity_Succeeds(t *testing.T) {
	e := NewEngine(nil)
	e.maxOrdersPerPair = 2
	now := time.Now().Unix()

	for i, id := range []string{"b1", "b2"} {
		if !e.AddOrder(r34Order(id, r34Pair, "buy", now+int64(i), "")) {
			t.Fatalf("AddOrder(%s buy) = false, want true", id)
		}
	}
	repl := r34Order("b1", r34Pair, "buy", now+10, "2000000000000000000")
	if !e.AddOrder(repl) {
		t.Fatal("AddOrder(b1 same-side replacement at capacity) = false, want true")
	}
	bids, _ := e.GetOrderbook(r34Pair)
	if len(bids) != 2 {
		t.Fatalf("bids len = %d, want 2", len(bids))
	}
	found := false
	for _, o := range bids {
		if o.OrderID == "b1" && o.Price == "2000000000000000000" {
			found = true
		}
	}
	if !found {
		t.Errorf("replacement b1 with new price must be in book, bids = %+v", bids)
	}
	if e.orderIDToPair["b1"] != r34Pair {
		t.Error("index for b1 lost after same-side replacement")
	}
}

// 边界三：跨侧替换 + 目标侧未满 → 成功：旧单从对侧消失、新单进目标
// 侧、索引指向不变。
func TestAddOrder_CrossSideReplaceWithRoom_Succeeds(t *testing.T) {
	e := NewEngine(nil)
	e.maxOrdersPerPair = 2
	now := time.Now().Unix()

	if !e.AddOrder(r34Order("s1", r34Pair, "sell", now, "")) {
		t.Fatal("AddOrder(s1 sell) = false, want true")
	}
	if !e.AddOrder(r34Order("b1", r34Pair, "buy", now+1, "")) {
		t.Fatal("AddOrder(b1 buy) = false, want true")
	}
	if !e.AddOrder(r34Order("s1", r34Pair, "buy", now+10, "")) {
		t.Fatal("AddOrder(s1 cross-side replacement) = false, want true")
	}
	bids, asks := e.GetOrderbook(r34Pair)
	if len(asks) != 0 {
		t.Errorf("asks must be empty after cross-side replacement, got %d", len(asks))
	}
	if len(bids) != 2 {
		t.Fatalf("bids len = %d, want 2 (b1 + replaced s1)", len(bids))
	}
	seen := map[string]bool{}
	for _, o := range bids {
		seen[o.OrderID] = true
	}
	if !seen["s1"] || !seen["b1"] {
		t.Errorf("bids must contain b1 and s1, got %v", seen)
	}
	if e.orderIDToPair["s1"] != r34Pair {
		t.Error("index for s1 must point to pair after cross-side replacement")
	}
}
