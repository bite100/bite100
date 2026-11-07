package settlement

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// 公开的 anvil 测试账户 #0 私钥（人尽皆知的测试值），仅用于在单测里派生运营地址；
// 提交动作全部由 SubmitFn 假实现承担，不发任何真实交易。
const testOperatorKey = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

const (
	testToken0 = "0x1111111111111111111111111111111111111111"
	testToken1 = "0x2222222222222222222222222222222222222222"
	testMaker  = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	testTaker  = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
)

func submitterTestTrade(id string) *storage.Trade {
	tr := &storage.Trade{
		TradeID:      id,
		Pair:         "TKA/TKB",
		MakerOrderID: "maker-" + id,
		TakerOrderID: "taker-" + id,
		Maker:        testMaker,
		Taker:        testTaker,
		TokenIn:      testToken0,
		TokenOut:     testToken1,
		Price:        "1000000000000000000",
		Amount:       "100.000000000000000000", // 100 个 Token0，价格 1.0 → 双边折算各 100
		Timestamp:    1700000000,
	}
	tr.MakerOrder = &storage.SignedOrder{OrderID: tr.MakerOrderID, UserAddress: testMaker, TokenIn: testToken0, TokenOut: testToken1, AmountIn: "100", AmountOut: "100", Price: tr.Price, Timestamp: 1700000000, ExpiresAt: 1999999999, Nonce: 0, Signature: "0x1111"}
	tr.TakerOrder = &storage.SignedOrder{OrderID: tr.TakerOrderID, UserAddress: testTaker, TokenIn: testToken0, TokenOut: testToken1, AmountIn: "100", AmountOut: "100", Price: tr.Price, Timestamp: 1700000000, ExpiresAt: 1999999999, Nonce: 0, Signature: "0x2222"}
	return tr
}

type submitRecorder struct {
	mu    sync.Mutex
	calls int
	fn    func(call int) (string, error)
}

func (r *submitRecorder) submit(_ context.Context, _ *storage.Trade, _, _, _ string) (string, error) {
	r.mu.Lock()
	r.calls++
	c := r.calls
	r.mu.Unlock()
	return r.fn(c)
}

func (r *submitRecorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls
}

type fakeChain struct {
	mu     sync.Mutex
	filled map[string][2]int64 // orderID → (filledIn, filledOut)
	simErr error
}

func (f *fakeChain) OrderFilled(_ context.Context, so *storage.SignedOrder) (*big.Int, *big.Int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	v := f.filled[so.OrderID]
	return big.NewInt(v[0]), big.NewInt(v[1]), nil
}

func (f *fakeChain) SimulateSettle(_ context.Context, _ common.Address, _ Fill) error {
	return f.simErr
}

func newTestSubmitter(t *testing.T, db *storage.DB, rec *submitRecorder, chain ChainChecker, maxAttempts int) *Submitter {
	t.Helper()
	sub, err := NewSubmitter(SubmitterConfig{
		SettlementAddr: "0x3333333333333333333333333333333333333333",
		PrivateKeyHex:  testOperatorKey,
		Store:          db,
		MaxAttempts:    maxAttempts,
		BackoffBase:    15 * time.Millisecond,
		BackoffMax:     40 * time.Millisecond,
		SweepInterval:  40 * time.Millisecond,
		SubmitTimeout:  10 * time.Second,
		SubmitFn:       rec.submit,
		Chain:          chain,
		Now:            func() time.Time { return time.Unix(1700000000, 0) },
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	sub.Start(ctx)
	t.Cleanup(func() { cancel(); sub.Stop() })
	return sub
}

func openTestStore(t *testing.T) *storage.DB {
	t.Helper()
	db, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func waitTradeStatus(t *testing.T, db *storage.DB, id, want string) *storage.Trade {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		tr, err := db.GetTradeByID(id)
		if err == nil && tr != nil && tr.SettleStatus == want {
			return tr
		}
		time.Sleep(20 * time.Millisecond)
	}
	tr, _ := db.GetTradeByID(id)
	status := "<nil>"
	if tr != nil {
		status = tr.SettleStatus + " err=" + tr.SettleError
	}
	t.Fatalf("trade %s 未在期限内到达状态 %q（当前 %s）", id, want, status)
	return nil
}

// 正常路径 + 幂等：同一成交被重复 Enqueue/清扫也只提交一次
func TestSubmitterSettlesExactlyOnce(t *testing.T) {
	db := openTestStore(t)
	rec := &submitRecorder{fn: func(int) (string, error) { return "0xabc", nil }}
	sub := newTestSubmitter(t, db, rec, &fakeChain{filled: map[string][2]int64{}}, 5)

	tr := submitterTestTrade("once")
	if err := db.InsertTrade(tr); err != nil {
		t.Fatal(err)
	}
	sub.Enqueue(tr)
	got := waitTradeStatus(t, db, "once", storage.SettleSettled)
	if got.TxHash != "0xabc" {
		t.Errorf("txHash = %q, want 0xabc", got.TxHash)
	}
	// 重复触发：再次 Enqueue + 强制清扫，提交次数必须仍为 1
	sub.Enqueue(tr)
	sub.sweep(true)
	time.Sleep(300 * time.Millisecond)
	if rec.count() != 1 {
		t.Errorf("SubmitFn 被调用 %d 次, want 1", rec.count())
	}
}

// 瞬时失败指数退避重试，最终成功
func TestSubmitterRetriesTransientThenSucceeds(t *testing.T) {
	db := openTestStore(t)
	rec := &submitRecorder{fn: func(call int) (string, error) {
		if call < 3 {
			return "", errors.New("dial rpc: connection refused")
		}
		return "0xretry-ok", nil
	}}
	_ = newTestSubmitter(t, db, rec, &fakeChain{filled: map[string][2]int64{}}, 5)

	if err := db.InsertTrade(submitterTestTrade("flaky")); err != nil {
		t.Fatal(err)
	}
	got := waitTradeStatus(t, db, "flaky", storage.SettleSettled)
	if rec.count() != 3 {
		t.Errorf("SubmitFn 调用 %d 次, want 3", rec.count())
	}
	if got.SettleAttempts != 3 {
		t.Errorf("attempts = %d, want 3", got.SettleAttempts)
	}
}

// 已广播但链上 revert：确定性失败，只提交一次，tx 留痕
func TestSubmitterOnChainRevertIsTerminal(t *testing.T) {
	db := openTestStore(t)
	rec := &submitRecorder{fn: func(int) (string, error) {
		return "0xdead", errors.New("settlement: settleTrade reverted on-chain, tx=0xdead")
	}}
	_ = newTestSubmitter(t, db, rec, &fakeChain{filled: map[string][2]int64{}}, 5)

	if err := db.InsertTrade(submitterTestTrade("reverted")); err != nil {
		t.Fatal(err)
	}
	got := waitTradeStatus(t, db, "reverted", storage.SettleFailed)
	if got.TxHash != "0xdead" {
		t.Errorf("failed 应记录 revert tx, got %q", got.TxHash)
	}
	time.Sleep(300 * time.Millisecond)
	if rec.count() != 1 {
		t.Errorf("SubmitFn 调用 %d 次, want 1（终态不重试）", rec.count())
	}
}

// WaitMined 超时但未见回执（第二十七轮回归）：SubmitFn 返回空 hash + 瞬时
// 错误时，提交器必须重试到次数上限——绝不能像链上 revert 那样一次即终态，
// 也不得把该 hash 记为确定性失败的 tx（超时时交易可能仍在排队/刚上链）。
func TestSubmitterTimeoutWithoutHashRetries(t *testing.T) {
	db := openTestStore(t)
	rec := &submitRecorder{fn: func(int) (string, error) {
		return "", errors.New("settlement: wait mined timeout (receipt lookup: transaction pending)")
	}}
	_ = newTestSubmitter(t, db, rec, &fakeChain{filled: map[string][2]int64{}}, 2)

	if err := db.InsertTrade(submitterTestTrade("timeout")); err != nil {
		t.Fatal(err)
	}
	got := waitTradeStatus(t, db, "timeout", storage.SettleFailed)
	if rec.count() != 2 {
		t.Errorf("SubmitFn 调用 %d 次, want 2（超时未见回执应重试至上限，而非一次终态）", rec.count())
	}
	if got.TxHash != "" {
		t.Errorf("超时未见回执不得记录失败 tx, got %q", got.TxHash)
	}
	if got.SettleAttempts != 2 {
		t.Errorf("attempts = %d, want 2", got.SettleAttempts)
	}
}

// 交易已广播但仍在 mempool：SubmitFn 返回 (hash, ErrTxPending) 时，提交器
// 必须重试到次数上限——带 hash 也不得一次记终态。第二十九轮契约更新：
// 耗尽记终态时 hash 随记录保存（settle_error 保留 "attempts exhausted"
// 出处），供终态对账按回执定论（见 TestSubmitterReconcile* 系列）；第二十七
// 轮「失败记录不留 hash」的旧断言随之 supersede——旧行为下 hash 被丢弃，
// 这类成交永远停在 failed 且无从判定到底结算了没有。它仍不是一笔「已确认
// 失败」的交易：对账查到它落账会改判 settled、查不到（dropped）会重提。
func TestSubmitterPendingHashRetries(t *testing.T) {
	db := openTestStore(t)
	rec := &submitRecorder{fn: func(int) (string, error) {
		return "0xpending", fmt.Errorf("%w: 0xpending", ErrTxPending)
	}}
	_ = newTestSubmitter(t, db, rec, &fakeChain{filled: map[string][2]int64{}}, 2)

	if err := db.InsertTrade(submitterTestTrade("pending")); err != nil {
		t.Fatal(err)
	}
	got := waitTradeStatus(t, db, "pending", storage.SettleFailed)
	if rec.count() != 2 {
		t.Errorf("SubmitFn 调用 %d 次, want 2（pending 应重试至上限，而非一次终态）", rec.count())
	}
	if got.TxHash != "0xpending" {
		t.Errorf("耗尽终态应保存最后广播的 hash 供终态对账, got %q", got.TxHash)
	}
	if !strings.HasPrefix(got.SettleError, "attempts exhausted") {
		t.Errorf("终态出处应为 attempts exhausted（对账据此区分）, got %q", got.SettleError)
	}
}

// 链上对账已落账：跳过提交直接 settled（进程崩溃恢复场景）
func TestSubmitterSkipsAlreadyLanded(t *testing.T) {
	db := openTestStore(t)
	rec := &submitRecorder{fn: func(int) (string, error) { return "0xshould-not-happen", nil }}
	chain := &fakeChain{filled: map[string][2]int64{
		"maker-landed": {100, 100},
		"taker-landed": {100, 100},
	}}
	_ = newTestSubmitter(t, db, rec, chain, 5)

	if err := db.InsertTrade(submitterTestTrade("landed")); err != nil {
		t.Fatal(err)
	}
	got := waitTradeStatus(t, db, "landed", storage.SettleSettled)
	if rec.count() != 0 {
		t.Errorf("已落账成交不应再提交, SubmitFn 调用 %d 次", rec.count())
	}
	if got.TxHash != "" {
		t.Errorf("对账落账的 txHash 应为空（原 tx 不可知）, got %q", got.TxHash)
	}
}

// 模拟 revert：确定性失败且不发真实提交
func TestSubmitterSimulationRevertIsTerminal(t *testing.T) {
	db := openTestStore(t)
	rec := &submitRecorder{fn: func(int) (string, error) { return "0xnope", nil }}
	chain := &fakeChain{filled: map[string][2]int64{}, simErr: errors.New("execution reverted: Settlement: fill exceeds signed order")}
	_ = newTestSubmitter(t, db, rec, chain, 5)

	if err := db.InsertTrade(submitterTestTrade("simrev")); err != nil {
		t.Fatal(err)
	}
	waitTradeStatus(t, db, "simrev", storage.SettleFailed)
	if rec.count() != 0 {
		t.Errorf("模拟已 revert 不应真实提交, SubmitFn 调用 %d 次", rec.count())
	}
}

// 签名订单不可得：耗尽尝试后终态，SubmitFn 永不调用
func TestSubmitterMissingOrdersExhausts(t *testing.T) {
	db := openTestStore(t)
	rec := &submitRecorder{fn: func(int) (string, error) { return "0xnope", nil }}
	_ = newTestSubmitter(t, db, rec, &fakeChain{filled: map[string][2]int64{}}, 2)

	tr := submitterTestTrade("noorders")
	tr.MakerOrder, tr.TakerOrder = nil, nil
	if err := db.InsertTrade(tr); err != nil {
		t.Fatal(err)
	}
	got := waitTradeStatus(t, db, "noorders", storage.SettleFailed)
	if got.SettleAttempts != 2 {
		t.Errorf("attempts = %d, want 2", got.SettleAttempts)
	}
	if rec.count() != 0 {
		t.Errorf("无签名订单不应调用 SubmitFn, got %d 次", rec.count())
	}
}

// 清扫只接管待结算：已 settled/带 tx 的种子行不被重复提交
func TestSubmitterSweepSkipsSettledAndSeeded(t *testing.T) {
	db := openTestStore(t)
	done := submitterTestTrade("done")
	done.SettleStatus = storage.SettleSettled
	done.TxHash = "0xold"
	if err := db.InsertTrade(done); err != nil {
		t.Fatal(err)
	}
	seeded := submitterTestTrade("seeded")
	seeded.TxHash = "0xseed9"
	if err := db.InsertTrade(seeded); err != nil {
		t.Fatal(err)
	}
	rec := &submitRecorder{fn: func(int) (string, error) { return "0xnew", nil }}
	_ = newTestSubmitter(t, db, rec, &fakeChain{filled: map[string][2]int64{}}, 5)

	if err := db.InsertTrade(submitterTestTrade("fresh")); err != nil {
		t.Fatal(err)
	}
	waitTradeStatus(t, db, "fresh", storage.SettleSettled)
	time.Sleep(200 * time.Millisecond)
	if rec.count() != 1 {
		t.Errorf("SubmitFn 调用 %d 次, want 1（仅 fresh）", rec.count())
	}
}
