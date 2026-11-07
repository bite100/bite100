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
// Go 侧计算必须逐字节一致，且 ethers 产生的签名必须能被 Go 验签通过
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
		Signature:   "0x5e619be6ee3f627a45e531043bdf823d0c227a3bfbb32964ed2a3c1e2b85e76c04b25c9024f3a73ff6406d63972e63ea214bf62abdfaafdc147ca404998a23d21c",
	}

	digest, err := OrderDigest(so)
	if err != nil {
		t.Fatal(err)
	}
	want := common.HexToHash("0x6a3c557cec5b51cb843652a7a36b96bccc9eecc4eca030745110706cbfc8d2f1")
	if digest != want {
		t.Errorf("digest mismatch:\n got %s\nwant %s", digest.Hex(), want.Hex())
	}

	valid, err := VerifySignedOrder(so)
	if err != nil {
		t.Fatalf("VerifySignedOrder: %v", err)
	}
	if !valid {
		t.Error("ethers-produced signature should verify")
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
