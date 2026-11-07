package storage

import (
	"testing"
)

// 第二十九轮：终态对账的存储面——ListFailedTradesWithTxHash 只收
// 「failed 且带 hash」的行；ResetFailedTradeForResubmit 把行重置回
// 待提交（清 hash、清尝试计数），且只对 failed 行生效。
func TestFailedTradesWithTxHashAndReset(t *testing.T) {
	db, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mk := func(id string) {
		if err := db.InsertTrade(settleTestTrade(id, true)); err != nil {
			t.Fatal(err)
		}
	}
	mk("f-hash")
	mk("f-nohash")
	mk("s-hash")
	mk("p-plain")
	if err := db.MarkTradeSettleFailed("f-hash", "attempts exhausted (12): pending", "0xabc"); err != nil {
		t.Fatal(err)
	}
	if err := db.MarkTradeSettleFailed("f-nohash", "simulation reverted", ""); err != nil {
		t.Fatal(err)
	}
	if err := db.MarkTradeSettled("s-hash", "0xdef", ""); err != nil {
		t.Fatal(err)
	}

	list, err := db.ListFailedTradesWithTxHash(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].TradeID != "f-hash" {
		t.Fatalf("ListFailedTradesWithTxHash = %v, want 仅 [f-hash]", list)
	}

	// 对非 failed 行调用重置不得生效（防误动 settled 行）
	if err := db.ResetFailedTradeForResubmit("s-hash", "should not apply"); err != nil {
		t.Fatal(err)
	}
	st, _ := db.GetTradeByID("s-hash")
	if st.SettleStatus != SettleSettled || st.TxHash != "0xdef" {
		t.Errorf("settled 行被误重置: status=%q hash=%q", st.SettleStatus, st.TxHash)
	}

	// 正规重置：状态回 pending、hash 清空、尝试计数清零，随后能被待结算扫描接管
	if err := db.ResetFailedTradeForResubmit("f-hash", "dropped, resubmit"); err != nil {
		t.Fatal(err)
	}
	got, _ := db.GetTradeByID("f-hash")
	if got.SettleStatus != SettlePending || got.TxHash != "" || got.SettleAttempts != 0 {
		t.Errorf("重置后: status=%q hash=%q attempts=%d, want pending/\"\"/0", got.SettleStatus, got.TxHash, got.SettleAttempts)
	}
	pending, err := db.ListTradesForSettlement(10)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, tr := range pending {
		if tr.TradeID == "f-hash" {
			found = true
		}
	}
	if !found {
		t.Error("重置后的成交未被 ListTradesForSettlement 接管")
	}
}
