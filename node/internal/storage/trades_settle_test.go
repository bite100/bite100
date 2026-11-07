package storage

import (
	"testing"
)

func settleTestTrade(id string, withOrders bool) *Trade {
	tr := &Trade{
		TradeID:      id,
		Pair:         "TKA/TKB",
		MakerOrderID: "maker-" + id,
		TakerOrderID: "taker-" + id,
		Maker:        "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		Taker:        "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
		TokenIn:      "0x1111111111111111111111111111111111111111",
		TokenOut:     "0x2222222222222222222222222222222222222222",
		Price:        "1000000000000000000",
		Amount:       "100.000000000000000000",
		Timestamp:    1700000000,
	}
	if withOrders {
		tr.MakerOrder = &SignedOrder{OrderID: tr.MakerOrderID, UserAddress: tr.Maker, TokenIn: tr.TokenIn, TokenOut: tr.TokenOut, AmountIn: "100", AmountOut: "100", Price: tr.Price, Timestamp: 1700000000, ExpiresAt: 1999999999, Nonce: 0, Signature: "0x1111"}
		tr.TakerOrder = &SignedOrder{OrderID: tr.TakerOrderID, UserAddress: tr.Taker, TokenIn: tr.TokenIn, TokenOut: tr.TokenOut, AmountIn: "100", AmountOut: "100", Price: tr.Price, Timestamp: 1700000000, ExpiresAt: 1999999999, Nonce: 0, Signature: "0x2222"}
	}
	return tr
}

func TestTradeSettleLifecycle(t *testing.T) {
	db, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	tr := settleTestTrade("t1", true)
	if err := db.InsertTrade(tr); err != nil {
		t.Fatal(err)
	}
	got, err := db.GetTradeByID("t1")
	if err != nil || got == nil {
		t.Fatalf("GetTradeByID: %v / %v", got, err)
	}
	if got.SettleStatus != SettlePending {
		t.Errorf("status = %q, want pending", got.SettleStatus)
	}
	if got.MakerOrder == nil || got.TakerOrder == nil {
		t.Fatal("签名订单 JSON 未落库/未读回")
	}
	if got.MakerOrder.OrderID != "maker-t1" || got.TakerOrder.Signature != "0x2222" {
		t.Errorf("签名订单读回不一致: %+v / %+v", got.MakerOrder, got.TakerOrder)
	}

	// 待结算清单包含它
	pending, err := db.ListTradesForSettlement(10)
	if err != nil || len(pending) != 1 {
		t.Fatalf("ListTradesForSettlement = %d, err=%v", len(pending), err)
	}

	// 领取一次成功、第二次失败（原子性）
	ok, err := db.ClaimTradeForSettlement("t1")
	if err != nil || !ok {
		t.Fatalf("首次领取 = %v, err=%v", ok, err)
	}
	ok, err = db.ClaimTradeForSettlement("t1")
	if err != nil || ok {
		t.Fatalf("重复领取 = %v, err=%v（应为 false）", ok, err)
	}
	got, _ = db.GetTradeByID("t1")
	if got.SettleStatus != SettleSubmitting || got.SettleAttempts != 1 {
		t.Errorf("领取后状态 = %q attempts=%d", got.SettleStatus, got.SettleAttempts)
	}

	// 崩溃恢复：submitting → pending
	if n, err := db.RecoverSubmittingTrades(); err != nil || n != 1 {
		t.Fatalf("RecoverSubmittingTrades = %d, err=%v", n, err)
	}
	if ok, _ := db.ClaimTradeForSettlement("t1"); !ok {
		t.Fatal("恢复后应可重新领取")
	}

	// 标记已结算后退出待结算清单
	if err := db.MarkTradeSettled("t1", "0xabc", ""); err != nil {
		t.Fatal(err)
	}
	got, _ = db.GetTradeByID("t1")
	if got.SettleStatus != SettleSettled || got.TxHash != "0xabc" {
		t.Errorf("settled 后 = %q tx=%q", got.SettleStatus, got.TxHash)
	}
	pending, _ = db.ListTradesForSettlement(10)
	if len(pending) != 0 {
		t.Errorf("已结算仍出现在待结算清单: %d", len(pending))
	}
	// settled 累计查询（提交器对账用）
	settled, err := db.ListSettledTradesByOrder("maker-t1")
	if err != nil || len(settled) != 1 {
		t.Errorf("ListSettledTradesByOrder = %d, err=%v", len(settled), err)
	}
}

func TestInsertTradePreservesSettleState(t *testing.T) {
	db, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	tr := settleTestTrade("t2", true)
	if err := db.InsertTrade(tr); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ClaimTradeForSettlement("t2"); err != nil {
		t.Fatal(err)
	}
	if err := db.MarkTradeSettled("t2", "0xfeed", ""); err != nil {
		t.Fatal(err)
	}
	// gossip 回声：同 trade_id 再次落库（无签名订单、无状态）不得回滚结算状态，
	// 且不得抹掉已落库的签名订单 JSON
	echo := settleTestTrade("t2", false)
	if err := db.InsertTrade(echo); err != nil {
		t.Fatal(err)
	}
	got, _ := db.GetTradeByID("t2")
	if got.SettleStatus != SettleSettled || got.TxHash != "0xfeed" {
		t.Errorf("重复落库回滚了结算状态: %q tx=%q", got.SettleStatus, got.TxHash)
	}
	if got.MakerOrder == nil {
		t.Error("重复落库抹掉了签名订单 JSON")
	}
}

func TestRecomputeOrderFill(t *testing.T) {
	db, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// 订单：买 100（token0 口径，与引擎 Trade.Amount 一致）
	order := &Order{
		OrderID: "ord-1", Trader: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		Pair: "TKA/TKB", Side: "buy", Price: "1000000000000000000",
		Amount: "100.000000000000000000", Filled: "0", Status: "open",
		Nonce: 2, CreatedAt: 1700000000, ExpiresAt: 1999999999,
	}
	if err := db.InsertOrder(order); err != nil {
		t.Fatal(err)
	}
	// 无成交：不回写
	if f, s, err := db.RecomputeOrderFill("ord-1"); err != nil || f != "0" || s != "open" {
		t.Fatalf("无成交重算 = (%q,%q,%v), want (0,open,nil)", f, s, err)
	}
	// 第一笔成交 40 → partial
	tr1 := settleTestTrade("fill-1", false)
	tr1.MakerOrderID, tr1.TakerOrderID = "other-maker", "ord-1"
	tr1.Amount = "40.000000000000000000"
	if err := db.InsertTrade(tr1); err != nil {
		t.Fatal(err)
	}
	if f, s, err := db.RecomputeOrderFill("ord-1"); err != nil || f != "40.000000000000000000" || s != "partial" {
		t.Fatalf("部分成交重算 = (%q,%q,%v)", f, s, err)
	}
	got, _ := db.GetOrder("ord-1")
	if got.Filled != "40.000000000000000000" || got.Status != "partial" {
		t.Errorf("回写后订单 = filled=%q status=%q", got.Filled, got.Status)
	}
	// 第二笔成交 60 → 全额 filled
	tr2 := settleTestTrade("fill-2", false)
	tr2.MakerOrderID, tr2.TakerOrderID = "ord-1", "other-taker"
	tr2.Amount = "60.000000000000000000"
	if err := db.InsertTrade(tr2); err != nil {
		t.Fatal(err)
	}
	if f, s, err := db.RecomputeOrderFill("ord-1"); err != nil || f != "100.000000000000000000" || s != "filled" {
		t.Fatalf("全额成交重算 = (%q,%q,%v)", f, s, err)
	}
	// gossip 回声：同一成交重复落库后重算，不得多算
	if err := db.InsertTrade(tr2); err != nil {
		t.Fatal(err)
	}
	if f, s, err := db.RecomputeOrderFill("ord-1"); err != nil || f != "100.000000000000000000" || s != "filled" {
		t.Fatalf("重复落库后重算 = (%q,%q,%v)，多算了", f, s, err)
	}
	// 不存在的订单：静默空返回；已撤单的订单：不碰
	if f, s, err := db.RecomputeOrderFill("no-such-order"); err != nil || f != "" || s != "" {
		t.Fatalf("不存在订单重算 = (%q,%q,%v)", f, s, err)
	}
	if err := db.UpdateOrderStatus("ord-1", "cancelled", "100.000000000000000000"); err != nil {
		t.Fatal(err)
	}
	if f, s, err := db.RecomputeOrderFill("ord-1"); err != nil || s != "cancelled" {
		t.Fatalf("已撤单重算 = (%q,%q,%v)，应保持 cancelled", f, s, err)
	}
}

func TestListTradesForSettlementPredicate(t *testing.T) {
	db, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// 带 tx_hash 的行（种子/历史已落账）不进清单
	seeded := settleTestTrade("seed", false)
	seeded.TxHash = "0xseed0"
	if err := db.InsertTrade(seeded); err != nil {
		t.Fatal(err)
	}
	// failed 终态不进清单
	failed := settleTestTrade("bad", true)
	if err := db.InsertTrade(failed); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ClaimTradeForSettlement("bad"); err != nil {
		t.Fatal(err)
	}
	if err := db.MarkTradeSettleFailed("bad", "simulation reverted", ""); err != nil {
		t.Fatal(err)
	}
	// retry 在清单内
	retry := settleTestTrade("retry", true)
	if err := db.InsertTrade(retry); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ClaimTradeForSettlement("retry"); err != nil {
		t.Fatal(err)
	}
	if err := db.MarkTradeSettleRetry("retry", "dial rpc: refused"); err != nil {
		t.Fatal(err)
	}
	// 普通 pending 在清单内
	if err := db.InsertTrade(settleTestTrade("fresh", true)); err != nil {
		t.Fatal(err)
	}

	list, err := db.ListTradesForSettlement(10)
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, x := range list {
		ids[x.TradeID] = true
	}
	if len(list) != 2 || !ids["retry"] || !ids["fresh"] {
		t.Errorf("待结算清单 = %v, want {retry, fresh}", ids)
	}
}
