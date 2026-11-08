package settlement

import (
	"testing"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

func lockTestOrder() *storage.SignedOrder {
	return &storage.SignedOrder{
		OrderID:     "lock-1",
		UserAddress: "0x1111111111111111111111111111111111111111",
		TokenIn:     "0x2222222222222222222222222222222222222222",
		TokenOut:    "0x3333333333333333333333333333333333333333",
		AmountIn:    "100000000000000000000",  // 100
		AmountOut:   "200000000000000000000",  // 200（price=2 派生）
		Price:       "2000000000000000000",
		Nonce:       0,
		Side:        1, // sell（阶段 3：方向在签名订单 Side 字段里，义务由此派生）
		Signature:   "0xab",
	}
}

func TestObligationForOrder_Sell(t *testing.T) {
	token, amount, payIn, err := ObligationForOrder(lockTestOrder())
	if err != nil {
		t.Fatalf("sell obligation: %v", err)
	}
	if !payIn {
		t.Fatalf("sell should pay with tokenIn")
	}
	if token.Hex() != "0x2222222222222222222222222222222222222222" {
		t.Fatalf("sell token = %s", token.Hex())
	}
	if amount.String() != "100000000000000000000" {
		t.Fatalf("sell amount = %s", amount.String())
	}
}

func TestObligationForOrder_Buy(t *testing.T) {
	buyOrder := lockTestOrder()
	buyOrder.Side = 0 // buy
	token, amount, payIn, err := ObligationForOrder(buyOrder)
	if err != nil {
		t.Fatalf("buy obligation: %v", err)
	}
	if payIn {
		t.Fatalf("buy should pay with tokenOut")
	}
	if token.Hex() != "0x3333333333333333333333333333333333333333" {
		t.Fatalf("buy token = %s", token.Hex())
	}
	if amount.String() != "200000000000000000000" {
		t.Fatalf("buy amount = %s", amount.String())
	}
}

func TestObligationForOrder_BadInputs(t *testing.T) {
	// 阶段 3：非法签名 side（∉ {0,1}）必须 fail-closed 报错——方向不再有
	// 调用方字符串入口，未知方向只能以非法 Side 值的形式出现。
	badSide := lockTestOrder()
	badSide.Side = 2
	if _, _, _, err := ObligationForOrder(badSide); err == nil {
		t.Fatalf("invalid side should error")
	}
	if _, _, _, err := ObligationForOrder(nil); err == nil {
		t.Fatalf("nil order should error")
	}
	bad := lockTestOrder()
	bad.AmountIn = "not-a-number"
	if _, _, _, err := ObligationForOrder(bad); err == nil {
		t.Fatalf("bad amountIn should error")
	}
}

func TestLockOrder_UnsignedRejected(t *testing.T) {
	so := lockTestOrder()
	so.Signature = ""
	// 无签名在拨号前即被拒（不发交易、不碰网络）
	_, _, err := LockOrder(t.Context(), "http://127.0.0.1:1", "0x4444444444444444444444444444444444444444", "0x5555555555555555555555555555555555555555", "00", so)
	if err == nil {
		t.Fatalf("unsigned order should be rejected")
	}
}
