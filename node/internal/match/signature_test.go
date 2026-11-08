package match

import (
	"fmt"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// TestVerifyOrderSignature 统一规范往返：SignOrder 签名后 VerifyOrderSignature 应通过；篡改金额应失败
func TestVerifyOrderSignature(t *testing.T) {
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	addr := crypto.PubkeyToAddress(key.PublicKey)

	pairTokens := &PairTokens{Token0: "0x1111111111111111111111111111111111111111", Token1: "0x2222222222222222222222222222222222222222"}
	order := &storage.Order{
		OrderID:   "order_test_123",
		Trader:    addr.Hex(),
		Pair:      "TKA/TKB",
		Side:      "sell",
		Price:     "2000000000000000000", // 2e18 定点
		Amount:    "500000000000000000",  // 0.5e18
		CreatedAt: 1700000000,
		ExpiresAt: 1700086400,
		Nonce:     3,
	}

	so := BuildSignedOrder(order, pairTokens)
	// amountOut 统一公式：0.5e18 * 2e18 / 1e18 = 1e18
	if so.AmountOut != "1000000000000000000" {
		t.Fatalf("amountOut derivation wrong: %s", so.AmountOut)
	}
	if so.Nonce != 3 {
		t.Fatalf("nonce not carried into signed order: %d", so.Nonce)
	}

	sig, err := SignOrder(key, so)
	if err != nil {
		t.Fatal(err)
	}
	order.Signature = sig

	valid, err := VerifyOrderSignature(order, pairTokens)
	if err != nil {
		t.Fatalf("VerifyOrderSignature: %v", err)
	}
	if !valid {
		t.Error("expected valid signature")
	}

	// 篡改数量后签名应失效
	order.Amount = "600000000000000000"
	valid, err = VerifyOrderSignature(order, pairTokens)
	if err != nil {
		t.Fatalf("VerifyOrderSignature tampered: %v", err)
	}
	if valid {
		t.Error("expected invalid signature after tampering amount")
	}
}

func TestVerifyOrderSignature_missingSig(t *testing.T) {
	order := &storage.Order{OrderID: "o1", Trader: "0x123", Amount: "1", Price: "1", CreatedAt: 1}
	valid, err := VerifyOrderSignature(order, nil)
	if err == nil || valid {
		t.Errorf("expected error for missing signature, got valid=%v err=%v", valid, err)
	}
}

// TestOrderDigestCrossLanguageVector 跨语言向量：digest 由 ethers TypedDataEncoder 生成（见 docs/eip712-order-spec.md §6），
// Go 侧计算必须逐字节一致，且 ethers 产生的签名必须能被 Go 验签通过。
// 阶段 3 切换（2026-11-08）：Order 消息新增 side 字段（uint8 末位），本向量已
// 换为含 side 的新向量；旧向量（无 side，digest 0x6a3c557c…、sig 0x5e619be6…）
// 随旧结构体一并作废，仅作历史记录，不得再用作断言。
func TestOrderDigestCrossLanguageVector(t *testing.T) {
	SetDomain(big.NewInt(31337), common.HexToAddress("0x5FbDB2315678afecb367f032d93F642f64180aa3"))
	defer SetDomain(big.NewInt(11155111), common.HexToAddress("0xee35587f3e3f500de9f9E1E97c340F801dc71078"))

	so := &storage.SignedOrder{
		OrderID:     "order_vector_1",
		UserAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
		TokenIn:     "0x1111111111111111111111111111111111111111",
		TokenOut:    "0x2222222222222222222222222222222222222222",
		AmountIn:    "100000000000000000000",
		AmountOut:   "200000000000000000000",
		Price:       "2000000000000000000",
		Timestamp:   1700000000,
		ExpiresAt:   1700086400,
		Nonce:       0,
		Side:        SideSell,
		Signature:   "0xc7d48a6fdc483a27fa1c04cdfa92b5e4fb162cd94c747ffca46b73222b34f9ae4c2751772e5e43bbcee2b9d84a46eee9a7e472fddcf1bd58542760c0afe9ec9c1b",
	}

	digest, err := OrderDigest(so)
	if err != nil {
		t.Fatal(err)
	}
	want := common.HexToHash("0xd793d795036c2d1b548120e9e73ea43a608529b4a23f0d3254c263fde391cec0")
	if digest != want {
		t.Errorf("digest mismatch (side=1):\n got %s\nwant %s", digest.Hex(), want.Hex())
	}

	valid, err := VerifySignedOrder(so)
	if err != nil {
		t.Fatalf("VerifySignedOrder: %v", err)
	}
	if !valid {
		t.Error("ethers-produced signature should verify")
	}

	// side=0（buy）：同一订单仅 side 不同，digest 必须与 ethers 向量一致，
	// 且与 side=1 的 digest 不同（side 真实进入签名摘要，非摆设字段）。
	soBuy := *so
	soBuy.Side = SideBuy
	soBuy.Signature = ""
	digestBuy, err := OrderDigest(&soBuy)
	if err != nil {
		t.Fatal(err)
	}
	wantBuy := common.HexToHash("0x158420436d13a5daba116dd1d1165168c8a759711f13665f371223d246231b96")
	if digestBuy != wantBuy {
		t.Errorf("digest mismatch (side=0):\n got %s\nwant %s", digestBuy.Hex(), wantBuy.Hex())
	}
	if digestBuy == digest {
		t.Error("side must change the digest")
	}
}

// TestVerifySignedOrder_InvalidSideRejected 非法 side 的 fail-closed 口径：
// 签名订单 side ∉ {0,1} 必须被验签拒绝（错误而非默认成 buy）；订单簿 side
// 字符串未知时 BuildSignedOrder 映射非法哨兵、VerifyOrderSignature 同样拒绝——
// 即便签名是对同订单 buy 口径签出的，也不能以未知 side 混入。
func TestVerifySignedOrder_InvalidSideRejected(t *testing.T) {
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	addr := crypto.PubkeyToAddress(key.PublicKey)
	pairTokens := &PairTokens{Token0: "0x1111111111111111111111111111111111111111", Token1: "0x2222222222222222222222222222222222222222"}

	order := &storage.Order{
		OrderID: "order_bad_side", Trader: addr.Hex(), Pair: "TKA/TKB", Side: "buy",
		Price: "2000000000000000000", Amount: "500000000000000000",
		CreatedAt: 1700000000, ExpiresAt: 1700086400, Nonce: 0,
	}
	so := BuildSignedOrder(order, pairTokens)
	if so.Side != SideBuy {
		t.Fatalf("buy must map to side 0, got %d", so.Side)
	}
	sig, err := SignOrder(key, so)
	if err != nil {
		t.Fatal(err)
	}
	order.Signature = sig

	// 签名订单侧：side 改为非法值 2 → 验签必须报错拒绝
	bad := *so
	bad.Side = 2
	bad.Signature = sig
	if valid, err := VerifySignedOrder(&bad); err == nil || valid {
		t.Errorf("side=2 must be rejected, got valid=%v err=%v", valid, err)
	}

	// 订单簿侧：同一签名挂上未知 side 字符串 → 必须拒绝（不得默认 buy 验过）
	order.Side = "hold"
	if valid, err := VerifyOrderSignature(order, pairTokens); err == nil || valid {
		t.Errorf("unknown order side must be rejected, got valid=%v err=%v", valid, err)
	}
	if got := BuildSignedOrder(order, pairTokens).Side; ValidSignedSide(got) {
		t.Errorf("unknown order side must map to an invalid sentinel, got %d", got)
	}

	// sell 映射回归：sell→1
	order.Side = "sell"
	if got := BuildSignedOrder(order, pairTokens).Side; got != SideSell {
		t.Errorf("sell must map to side 1, got %d", got)
	}
}

// TestSignCancelOrder 撤单签名往返：SignCancelOrder 签名后
// VerifyCancelSignature 应通过；换时间戳应失败（签名绑定 timestamp）
func TestSignCancelOrder(t *testing.T) {
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	addr := crypto.PubkeyToAddress(key.PublicKey)
	orderID := "order_xxx"
	timestamp := int64(1700000000)

	sig, err := SignCancelOrder(key, orderID, addr.Hex(), timestamp)
	if err != nil {
		t.Fatal(err)
	}
	valid, err := VerifyCancelSignature(orderID, addr.Hex(), sig, timestamp)
	if err != nil {
		t.Fatalf("VerifyCancelSignature: %v", err)
	}
	if !valid {
		t.Error("expected valid cancel signature")
	}
	valid, err = VerifyCancelSignature(orderID, addr.Hex(), sig, timestamp+1)
	if err != nil {
		t.Fatalf("VerifyCancelSignature other-ts: %v", err)
	}
	if valid {
		t.Error("cancel signature must not verify under another timestamp")
	}
}

func TestVerifyCancelSignature(t *testing.T) {
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	addr := crypto.PubkeyToAddress(key.PublicKey)
	orderID := "order_xxx"
	timestamp := int64(1700000000)

	typedData := apitypes.TypedData{
		Types:       cancelTypes,
		PrimaryType: "CancelOrder",
		Domain:      CurrentDomain(),
		Message: apitypes.TypedDataMessage{
			"orderId":     orderID,
			"userAddress": addr.Hex(),
			"timestamp":   fmt.Sprintf("%d", timestamp),
		},
	}
	digest, err := typedDataDigest(typedData, "CancelOrder")
	if err != nil {
		t.Fatal(err)
	}
	sig, _ := crypto.Sign(digest.Bytes(), key)
	sig[64] += 27
	signature := "0x" + common.Bytes2Hex(sig)

	valid, err := VerifyCancelSignature(orderID, addr.Hex(), signature, timestamp)
	if err != nil {
		t.Fatalf("VerifyCancelSignature: %v", err)
	}
	if !valid {
		t.Error("expected valid cancel signature")
	}
}
