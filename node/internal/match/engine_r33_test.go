package match

import (
	"testing"
	"time"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// 第 33 轮整改（ChatGPT 复审 N2/N3）：订单簿两条写入路径（AddOrder /
// ReplaceOrderbook）共用同一套校验（归一化 + 容量 + ID 全局唯一），且任
// 一失败路径都保证簿与 orderIDToPair 索引同生同灭。

func r33Order(id, pair, side string, created, expires int64) *storage.Order {
	return &storage.Order{
		OrderID:   id,
		Trader:    "0x1111111111111111111111111111111111111111",
		Pair:      pair,
		Side:      side,
		Price:     "1000000000000000000",
		Amount:    "1000000000000000000",
		CreatedAt: created,
		ExpiresAt: expires,
	}
}

// N2 核心场景：第 32 轮实现先删同 ID 旧单再算剩余量，剩余量 ≤ 0 的替换单
// 提前返回时旧单已删、索引残留。修复后：校验先于动簿，替换失败 = 无事
// 发生（旧单原样留簿、索引不动）；合法替换仍然生效。
func TestAddOrder_ReplaceWithZeroRemaining_KeepsOldOrderAndIndex(t *testing.T) {
	e := NewEngine(nil)
	now := time.Now().Unix()
	const pair = "TKA/TKB"

	if !e.AddOrder(r33Order("s1", pair, "sell", now, now+3600)) {
		t.Fatal("AddOrder(s1) = false, want true")
	}

	// 剩余量 = 0 的替换（Filled == Amount）→ 拒绝，旧单与索引保持原状。
	full := r33Order("s1", pair, "sell", now+1, now+3600)
	full.Filled = full.Amount
	if e.AddOrder(full) {
		t.Error("AddOrder(s1, zero remaining) = true, want false")
	}
	_, asks := e.GetOrderbook(pair)
	if len(asks) != 1 || asks[0].OrderID != "s1" || bigNew(asks[0].Amount).Cmp(bigNew("1000000000000000000")) != 0 {
		t.Errorf("old order must stay untouched after failed replacement, asks = %+v", asks)
	}
	if e.orderIDToPair["s1"] != pair {
		t.Error("index for s1 must stay after failed replacement")
	}

	// 剩余量 < 0（Filled > Amount）同口径。
	over := r33Order("s1", pair, "sell", now+2, now+3600)
	over.Filled = "2000000000000000000"
	if e.AddOrder(over) {
		t.Error("AddOrder(s1, negative remaining) = true, want false")
	}
	_, asks = e.GetOrderbook(pair)
	if len(asks) != 1 {
		t.Fatalf("old order must stay after negative-remaining replacement, asks len = %d", len(asks))
	}

	// 合法替换（改价、剩余量 > 0）仍然成功，簿中只剩新单。
	repl := r33Order("s1", pair, "sell", now+3, now+3600)
	repl.Price = "2000000000000000000"
	if !e.AddOrder(repl) {
		t.Fatal("AddOrder(s1, valid replacement) = false, want true")
	}
	_, asks = e.GetOrderbook(pair)
	if len(asks) != 1 || asks[0].Price != "2000000000000000000" {
		t.Errorf("valid replacement must take effect, asks = %+v", asks)
	}
	if e.orderIDToPair["s1"] != pair {
		t.Error("index for s1 lost after valid replacement")
	}
}

// ID 全局唯一（AddOrder 路径）：同一 orderID 已在其它交易对在簿时，
// 新 pair 的同 ID 单被拒，两边簿与索引互不污染。
func TestAddOrder_CrossPairDuplicateIDRejected(t *testing.T) {
	e := NewEngine(nil)
	now := time.Now().Unix()

	if !e.AddOrder(r33Order("x1", "AAA/BBB", "buy", now, now+3600)) {
		t.Fatal("AddOrder(x1 @ AAA/BBB) = false, want true")
	}
	if e.AddOrder(r33Order("x1", "CCC/DDD", "buy", now, now+3600)) {
		t.Error("AddOrder(x1 @ CCC/DDD) = true, want false (ID occupied by another pair)")
	}
	bids, _ := e.GetOrderbook("CCC/DDD")
	if len(bids) != 0 {
		t.Errorf("CCC/DDD book must stay empty, got %d bids", len(bids))
	}
	if e.orderIDToPair["x1"] != "AAA/BBB" {
		t.Error("index for x1 must still point to AAA/BBB")
	}
	bids, _ = e.GetOrderbook("AAA/BBB")
	if len(bids) != 1 {
		t.Errorf("AAA/BBB book must be intact, got %d bids", len(bids))
	}
}

// N3 核心场景：ReplaceOrderbook 此前逐笔裸 append，绕过容量上限且不查
// 重 ID。修复后：容量截断（输入序优先）、批内重 ID 先到先得、跨 pair
// 占用不抢索引、重建后旧索引清除干净。
func TestReplaceOrderbook_EnforcesCapacityAndUniqueness(t *testing.T) {
	e := NewEngine(nil)
	e.maxOrdersPerPair = 3
	now := time.Now().Unix()
	const pair = "BTC/USDT"
	const other = "ETH/USDT"

	// 另一交易对先占住 ID "shared"。
	if !e.AddOrder(r33Order("shared", other, "buy", now, now+3600)) {
		t.Fatal("AddOrder(shared @ ETH/USDT) = false, want true")
	}

	mk := func(id, side string, i int) *storage.Order {
		return r33Order(id, pair, side, now+int64(i), now+3600)
	}
	bids := []*storage.Order{mk("b1", "buy", 1), mk("b2", "buy", 2), mk("b3", "buy", 3), mk("b4", "buy", 4), mk("b5", "buy", 5)}
	asks := []*storage.Order{
		mk("a1", "sell", 6),
		mk("b2", "sell", 7),     // 与买盘重 ID（批内跨侧重复）→ 跳过
		mk("shared", "sell", 8), // 已被其它 pair 占用 → 跳过、不抢索引
		mk("a2", "sell", 9),
	}
	e.ReplaceOrderbook(pair, bids, asks)

	gotBids, gotAsks := e.GetOrderbook(pair)
	if len(gotBids) != 3 {
		t.Fatalf("bids len = %d, want 3 (capacity truncation)", len(gotBids))
	}
	for _, id := range []string{"b1", "b2", "b3"} {
		if e.orderIDToPair[id] != pair {
			t.Errorf("orderIDToPair[%s] = %q, want %s", id, e.orderIDToPair[id], pair)
		}
	}
	for _, id := range []string{"b4", "b5"} {
		if _, ok := e.orderIDToPair[id]; ok {
			t.Errorf("orderIDToPair must not contain truncated order %s", id)
		}
	}
	if len(gotAsks) != 2 {
		t.Fatalf("asks len = %d, want 2 (dup + cross-pair skipped)", len(gotAsks))
	}
	for _, id := range []string{"a1", "a2"} {
		if e.orderIDToPair[id] != pair {
			t.Errorf("orderIDToPair[%s] = %q, want %s", id, e.orderIDToPair[id], pair)
		}
	}
	// "shared" 的索引与簿仍归原 pair。
	if e.orderIDToPair["shared"] != other {
		t.Error("index for shared must still point to ETH/USDT")
	}
	otherBids, _ := e.GetOrderbook(other)
	if len(otherBids) != 1 || otherBids[0].OrderID != "shared" {
		t.Error("ETH/USDT book must keep its shared order")
	}

	// 再次重建：旧簿索引全部清除，只剩新簿。
	e.ReplaceOrderbook(pair, []*storage.Order{mk("n1", "buy", 10)}, nil)
	if _, ok := e.orderIDToPair["b1"]; ok {
		t.Error("stale index for b1 must be cleared on rebuild")
	}
	gotBids, gotAsks = e.GetOrderbook(pair)
	if len(gotBids) != 1 || gotBids[0].OrderID != "n1" || len(gotAsks) != 0 {
		t.Errorf("rebuilt book mismatch: bids=%d asks=%d", len(gotBids), len(gotAsks))
	}
	if e.orderIDToPair["n1"] != pair {
		t.Error("index for n1 missing after rebuild")
	}
}

// ReplaceOrderbook 的归一化口径与 AddOrder 一致：nil、空 ID、已过期、
// 剩余量 ≤ 0、空价格的条目一律跳过，不入簿不写索引。
func TestReplaceOrderbook_SkipsInvalidEntries(t *testing.T) {
	e := NewEngine(nil)
	now := time.Now().Unix()
	const pair = "TKA/TKB"

	expired := r33Order("exp", pair, "buy", now-7200, now-3600)
	zeroLeft := r33Order("zero", pair, "buy", now, now+3600)
	zeroLeft.Filled = zeroLeft.Amount
	noPrice := r33Order("nop", pair, "buy", now, now+3600)
	noPrice.Price = ""
	emptyID := r33Order("", pair, "buy", now, now+3600)
	valid := r33Order("ok1", pair, "buy", now, now+3600)

	e.ReplaceOrderbook(pair, []*storage.Order{nil, emptyID, expired, zeroLeft, noPrice, valid}, nil)

	bids, _ := e.GetOrderbook(pair)
	if len(bids) != 1 || bids[0].OrderID != "ok1" {
		t.Fatalf("only ok1 must enter the book, got %+v", bids)
	}
	for _, id := range []string{"exp", "zero", "nop"} {
		if _, ok := e.orderIDToPair[id]; ok {
			t.Errorf("orderIDToPair must not contain skipped order %s", id)
		}
	}
}

// 阶段 3 fail-closed：未知 side 不得入簿（此前非 buy 一律按卖盘处理，未知
// 方向会冒充卖单挂簿），AddOrder / ReplaceOrderbook / Match 三条路径同口径。
func TestInvalidSideNeverEntersBook(t *testing.T) {
	e := NewEngine(nil)
	now := time.Now().Unix()
	const pair = "TKA/TKB"

	if e.AddOrder(r33Order("bad1", pair, "hold", now, now+3600)) {
		t.Error("AddOrder(hold) = true, want false")
	}
	e.ReplaceOrderbook(pair, nil, []*storage.Order{r33Order("bad2", pair, "hold", now, now+3600)})
	bids, asks := e.GetOrderbook(pair)
	if len(bids) != 0 || len(asks) != 0 {
		t.Errorf("invalid side must not enter book via ReplaceOrderbook, bids=%d asks=%d", len(bids), len(asks))
	}
	if _, ok := e.orderIDToPair["bad2"]; ok {
		t.Error("orderIDToPair must not contain invalid-side order")
	}
	if trades := e.Match(r33Order("bad3", pair, "hold", now, now+3600)); len(trades) != 0 {
		t.Errorf("Match(hold) must produce no trades, got %d", len(trades))
	}
}
