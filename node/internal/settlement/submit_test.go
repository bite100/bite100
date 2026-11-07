package settlement

import (
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

func testSignedOrder(user, tokenIn, tokenOut, amountIn, amountOut, price string, nonce int64) *storage.SignedOrder {
	return &storage.SignedOrder{
		OrderID:     "o-" + user[len(user)-4:],
		UserAddress: user,
		TokenIn:     tokenIn,
		TokenOut:    tokenOut,
		AmountIn:    amountIn,
		AmountOut:   amountOut,
		Price:       price,
		Timestamp:   1700000000,
		ExpiresAt:   1700086400,
		Nonce:       nonce,
		Signature:   "0x" + "11",
	}
}

// maker 卖 Token0：fill.amountIn = 成交 Token0 量，amountOut = 量 * price / 1e18
func TestTradeToFill_MakerSellsToken0(t *testing.T) {
	const (
		t0 = "0x1111111111111111111111111111111111111111"
		t1 = "0x2222222222222222222222222222222222222222"
	)
	tr := &storage.Trade{
		TokenIn:  t0,
		TokenOut: t1,
		Amount:   "100.000000000000000000", // 100 个 Token0（最小单位口径下即 100）
		MakerOrder: testSignedOrder("0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", t0, t1,
			"100000000000000000000", "200000000000000000000", "2000000000000000000", 0),
		TakerOrder: testSignedOrder("0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", t0, t1,
			"100000000000000000000", "200000000000000000000", "2000000000000000000", 0),
	}
	fill, err := TradeToFill(tr)
	if err != nil {
		t.Fatal(err)
	}
	if fill.AmountIn.Cmp(big.NewInt(100)) != 0 {
		t.Errorf("amountIn = %s, want 100", fill.AmountIn)
	}
	if fill.AmountOut.Cmp(big.NewInt(200)) != 0 {
		t.Errorf("amountOut = %s, want 200 (100 * 2e18 / 1e18)", fill.AmountOut)
	}
	if fill.MakerOrder.Order.Nonce.Cmp(big.NewInt(0)) != 0 {
		t.Errorf("maker nonce not carried")
	}
}

// maker 买 Token0（付出 Token1）：fill.amountIn 为 Token1 量（qty*price/1e18），amountOut 为 Token0 量
func TestTradeToFill_MakerBuysToken0(t *testing.T) {
	const (
		t0 = "0x1111111111111111111111111111111111111111"
		t1 = "0x2222222222222222222222222222222222222222"
	)
	tr := &storage.Trade{
		TokenIn:  t1, // 结算方向以 maker 为准：maker 付出 Token1
		TokenOut: t0,
		Amount:   "50.000000000000000000",
		MakerOrder: testSignedOrder("0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", t0, t1,
			"50000000000000000000", "100000000000000000000", "2000000000000000000", 1),
		TakerOrder: testSignedOrder("0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", t0, t1,
			"50000000000000000000", "100000000000000000000", "2000000000000000000", 2),
	}
	fill, err := TradeToFill(tr)
	if err != nil {
		t.Fatal(err)
	}
	if fill.AmountIn.Cmp(big.NewInt(100)) != 0 {
		t.Errorf("amountIn = %s, want 100 (50 * 2e18 / 1e18)", fill.AmountIn)
	}
	if fill.AmountOut.Cmp(big.NewInt(50)) != 0 {
		t.Errorf("amountOut = %s, want 50", fill.AmountOut)
	}
}

func TestTradeToFill_MissingOrders(t *testing.T) {
	if _, err := TradeToFill(&storage.Trade{}); err == nil {
		t.Error("expected error when signed orders missing")
	}
}

// 第二十一轮：失败扣费 calldata 必须能用合约 ABI 正确编码（选择器 + 参数往返解码一致）
func TestPackFailureCharge(t *testing.T) {
	const (
		t0 = "0x1111111111111111111111111111111111111111"
		t1 = "0x2222222222222222222222222222222222222222"
	)
	so := testSignedOrder("0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", t0, t1,
		"100000000000000000000", "100000000000000000000", "1000000000000000000", 5)
	data, err := packFailureCharge(so, FailReasonOrderExpired, big.NewInt(500_000))
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 4 {
		t.Fatalf("calldata too short: %d", len(data))
	}
	// 选择器 = chargeFailedSettlement 的函数签名哈希前 4 字节
	parsed, err := abi.JSON(strings.NewReader(failureChargeABIJSON))
	if err != nil {
		t.Fatal(err)
	}
	method, err := parsed.MethodById(data[:4])
	if err != nil {
		t.Fatal(err)
	}
	if method.Name != "chargeFailedSettlement" {
		t.Errorf("method = %s, want chargeFailedSettlement", method.Name)
	}
	args, err := method.Inputs.Unpack(data[4:])
	if err != nil {
		t.Fatal(err)
	}
	if len(args) != 3 {
		t.Fatalf("args = %d, want 3", len(args))
	}
	if got := args[1].(uint8); got != FailReasonOrderExpired {
		t.Errorf("reason = %d, want %d", got, FailReasonOrderExpired)
	}
	if got := args[2].(*big.Int); got.Cmp(big.NewInt(500_000)) != 0 {
		t.Errorf("gasUsedClaimed = %s, want 500000", got)
	}
	// 不支持的归责类别在离线校验层就应被拒（与合约白名单一致）
	if FailReasonLockReleased != 2 {
		t.Errorf("FailReasonLockReleased = %d, want 2 (contract FAIL_LOCK_RELEASED)", FailReasonLockReleased)
	}
}
