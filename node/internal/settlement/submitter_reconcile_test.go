package settlement

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// 第二十九轮：终态对账（reconcileFailed）测试。假回执查询按 hash 给定论。

type fakeReceipts struct {
	mu      sync.Mutex
	verdict map[string][2]bool // hash → (found, success)
	calls   map[string]int
}

func (f *fakeReceipts) TxReceipt(_ context.Context, hash string) (bool, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.calls == nil {
		f.calls = map[string]int{}
	}
	f.calls[hash]++
	v, ok := f.verdict[hash]
	if !ok {
		return false, false, nil
	}
	return v[0], v[1], nil
}

func (f *fakeReceipts) callCount(hash string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[hash]
}

func newReconcileSubmitter(t *testing.T, db *storage.DB, rec *submitRecorder, receipts TxReceiptChecker) *Submitter {
	t.Helper()
	sub, err := NewSubmitter(SubmitterConfig{
		SettlementAddr: "0x3333333333333333333333333333333333333333",
		PrivateKeyHex:  testOperatorKey,
		Store:          db,
		MaxAttempts:    3,
		BackoffBase:    15 * time.Millisecond,
		BackoffMax:     40 * time.Millisecond,
		SweepInterval:  40 * time.Millisecond,
		SubmitTimeout:  10 * time.Second,
		SubmitFn:       rec.submit,
		Chain:          &fakeChain{filled: map[string][2]int64{}},
		Receipts:       receipts,
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

// seedFailed 造一笔「failed 且带 hash」的成交记录（模拟耗尽/终态后的留痕）
func seedFailed(t *testing.T, db *storage.DB, id, hash, errStr string) {
	t.Helper()
	if err := db.InsertTrade(submitterTestTrade(id)); err != nil {
		t.Fatal(err)
	}
	if err := db.MarkTradeSettleFailed(id, errStr, hash); err != nil {
		t.Fatal(err)
	}
}

// 广播其实已落账：failed+hash 经对账改判 settled，且不再重复提交
func TestSubmitterReconcileLandedTxMarkedSettled(t *testing.T) {
	db := openTestStore(t)
	seedFailed(t, db, "recon-landed", "0xlanded", "attempts exhausted (12): transaction pending: 0xlanded")
	rec := &submitRecorder{fn: func(int) (string, error) { return "0xshould-not-happen", nil }}
	receipts := &fakeReceipts{verdict: map[string][2]bool{"0xlanded": {true, true}}}
	_ = newReconcileSubmitter(t, db, rec, receipts)

	got := waitTradeStatus(t, db, "recon-landed", storage.SettleSettled)
	if got.TxHash != "0xlanded" {
		t.Errorf("改判后 txHash = %q, want 0xlanded", got.TxHash)
	}
	time.Sleep(200 * time.Millisecond)
	if rec.count() != 0 {
		t.Errorf("已落账成交不得重复提交, SubmitFn 调用 %d 次", rec.count())
	}
}

// 广播已被 dropped：出处为 attempts exhausted → 重置重提并最终 settled
func TestSubmitterReconcileDroppedTxResubmitted(t *testing.T) {
	db := openTestStore(t)
	seedFailed(t, db, "recon-dropped", "0xgone", "attempts exhausted (12): transaction dropped: 0xgone")
	rec := &submitRecorder{fn: func(int) (string, error) { return "0xnewhash", nil }}
	receipts := &fakeReceipts{verdict: map[string][2]bool{}} // 0xgone 查无此交易
	_ = newReconcileSubmitter(t, db, rec, receipts)

	got := waitTradeStatus(t, db, "recon-dropped", storage.SettleSettled)
	if got.TxHash != "0xnewhash" {
		t.Errorf("重提后 txHash = %q, want 0xnewhash", got.TxHash)
	}
	if rec.count() != 1 {
		t.Errorf("SubmitFn 调用 %d 次, want 1（仅重提一次）", rec.count())
	}
}

// 回执确认 revert：维持 failed 并打已核标记，后续清扫不再重复查回执
func TestSubmitterReconcileRevertedStaysFailed(t *testing.T) {
	db := openTestStore(t)
	seedFailed(t, db, "recon-reverted", "0xrev", "settleTrade reverted on-chain: execution reverted")
	rec := &submitRecorder{fn: func(int) (string, error) { return "0xnope", nil }}
	receipts := &fakeReceipts{verdict: map[string][2]bool{"0xrev": {true, false}}}
	sub := newReconcileSubmitter(t, db, rec, receipts)

	// 等对账给它打上已核标记
	deadline := time.Now().Add(10 * time.Second)
	for {
		tr, _ := db.GetTradeByID("recon-reverted")
		if tr != nil && tr.SettleStatus == storage.SettleFailed && tr.TxHash == "0xrev" &&
			len(tr.SettleError) > len("settleTrade reverted on-chain: execution reverted") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("对账未在期限内给 revert 记录打已核标记: %+v", tr)
		}
		time.Sleep(20 * time.Millisecond)
	}
	callsAfterMark := receipts.callCount("0xrev")
	sub.sweep(false)
	sub.sweep(false)
	time.Sleep(150 * time.Millisecond)
	if n := receipts.callCount("0xrev"); n != callsAfterMark {
		t.Errorf("已核标记后不应再查回执: 打标时 %d 次, 之后 %d 次", callsAfterMark, n)
	}
	if rec.count() != 0 {
		t.Errorf("revert 终态不得重提, SubmitFn 调用 %d 次", rec.count())
	}
}

// 无 hash 的失败记录不在对账输入集；非耗尽出处 + 查无交易 → 保持原样
func TestSubmitterReconcileLeavesOthersAlone(t *testing.T) {
	db := openTestStore(t)
	seedFailed(t, db, "recon-nohash", "", "simulation reverted: fill exceeds signed order")
	seedFailed(t, db, "recon-odd", "0xodd", "order expired before settlement")
	rec := &submitRecorder{fn: func(int) (string, error) { return "0xnope", nil }}
	receipts := &fakeReceipts{verdict: map[string][2]bool{}} // 0xodd 查无此交易
	sub := newReconcileSubmitter(t, db, rec, receipts)

	sub.sweep(false)
	time.Sleep(200 * time.Millisecond)
	for _, id := range []string{"recon-nohash", "recon-odd"} {
		tr, _ := db.GetTradeByID(id)
		if tr == nil || tr.SettleStatus != storage.SettleFailed {
			t.Errorf("%s: 状态被对账误动: %+v", id, tr)
		}
	}
	if n := receipts.callCount(""); n != 0 {
		t.Errorf("无 hash 记录不应查回执, got %d 次", n)
	}
	if rec.count() != 0 {
		t.Errorf("不应有任何提交, SubmitFn 调用 %d 次", rec.count())
	}
}
