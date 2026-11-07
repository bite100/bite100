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
		Signature:   "0xab",
	}
}

func TestObligationForOrder_Sell(t *testing.T) {
	token, amount, payIn, err := ObligationForOrder(lockTestOrder(), "sell")
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
	token, amount, payIn, err := ObligationForOrder(lockTestOrder(), "buy")
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
	if _, _, _, err := ObligationForOrder(lockTestOrder(), "hold"); err == nil {
		t.Fatalf("unknown side should error")
	}
	if _, _, _, err := ObligationForOrder(nil, "sell"); err == nil {
		t.Fatalf("nil order should error")
	}
	bad := lockTestOrder()
	bad.AmountIn = "not-a-number"
	if _, _, _, err := ObligationForOrder(bad, "sell"); err == nil {
		t.Fatalf("bad amountIn should error")
	}
}

func TestLockOrder_UnsignedRejected(t *testing.T) {
	so := lockTestOrder()
	so.Signature = ""
	// 无签名在拨号前即被拒（不发交易、不碰网络）
	_, _, err := LockOrder(t.Context(), "http://127.0.0.1:1", "0x4444444444444444444444444444444444444444", "0x5555555555555555555555555555555555555555", "00", so, "sell")
	if err == nil {
		t.Fatalf("unsigned order should be rejected")
	}
}
