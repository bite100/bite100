package match

import (
	"encoding/hex"
	"fmt"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// TestVerifyOrderSignature 验证 EIP-712 订单签名（6.1 订单签名验证）
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
		Side:      "buy",
		Price:     "1000000000000000000",
		Amount:    "500000000000000000",
		CreatedAt: 1700000000,
		ExpiresAt: 1700086400,
	}

	amountIn := new(big.Int)
	amountIn.SetString(order.Amount, 10)
	price := new(big.Int)
	price.SetString(order.Price, 10)
	amountOut := new(big.Int).Mul(amountIn, price)
	tokenIn, tokenOut := pairTokens.Token0, pairTokens.Token1

	typedData := apitypes.TypedData{
		Types:       orderTypes,
		PrimaryType: "Order",
		Domain:      domainSeparator,
		Message: apitypes.TypedDataMessage{
			"orderId":     order.OrderID,
			"userAddress": order.Trader,
			"tokenIn":     tokenIn,
			"tokenOut":    tokenOut,
			"amountIn":    amountIn.String(),
			"amountOut":   amountOut.String(),
			"price":       price.String(),
			"timestamp":   "1700000000",
			"expiresAt":   "1700086400",
		},
	}
	hash, err := typedData.HashStruct("Order", typedData.Message)
	if err != nil {
		t.Fatal(err)
	}
	domainHash, err := typedData.HashStruct("EIP712Domain", typedData.Domain.Map())
	if err != nil {
		t.Fatal(err)
	}
	rawData := []byte(fmt.Sprintf("\x19\x01%s%s", string(domainHash), string(hash)))
	finalHash := crypto.Keccak256Hash(rawData)

	sig, err := crypto.Sign(finalHash.Bytes(), key)
	if err != nil {
		t.Fatal(err)
	}
	sig[64] += 27 // 以太坊 v 值
	order.Signature = "0x" + hex.EncodeToString(sig)

	valid, err := VerifyOrderSignature(order, pairTokens)
	if err != nil {
		t.Fatalf("VerifyOrderSignature: %v", err)
	}
	if !valid {
		t.Error("expected valid signature")
	}
}

func TestVerifyOrderSignature_missingSig(t *testing.T) {
	order := &storage.Order{OrderID: "o1", Trader: "0x123", Amount: "1", Price: "1", CreatedAt: 1}
	valid, err := VerifyOrderSignature(order, nil)
	if err == nil || valid {
		t.Errorf("expected error for missing signature, got valid=%v err=%v", valid, err)
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

	cancelTypes := apitypes.Types{
		"EIP712Domain": {{Name: "name", Type: "string"}, {Name: "version", Type: "string"}, {Name: "chainId", Type: "uint256"}},
		"CancelOrder":  {{Name: "orderId", Type: "string"}, {Name: "userAddress", Type: "address"}, {Name: "timestamp", Type: "uint256"}},
	}
	typedData := apitypes.TypedData{
		Types:       cancelTypes,
		PrimaryType: "CancelOrder",
		Domain:      domainSeparator,
		Message:     apitypes.TypedDataMessage{"orderId": orderID, "userAddress": addr.Hex(), "timestamp": fmt.Sprintf("%d", timestamp)},
	}
	hash, _ := typedData.HashStruct("CancelOrder", typedData.Message)
	domainHash, _ := typedData.HashStruct("EIP712Domain", typedData.Domain.Map())
	rawData := []byte(fmt.Sprintf("\x19\x01%s%s", string(domainHash), string(hash)))
	finalHash := crypto.Keccak256Hash(rawData)
	sig, _ := crypto.Sign(finalHash.Bytes(), key)
	sig[64] += 27
	signature := "0x" + hex.EncodeToString(sig)

	valid, err := VerifyCancelSignature(orderID, addr.Hex(), signature, timestamp)
	if err != nil {
		t.Fatalf("VerifyCancelSignature: %v", err)
	}
	if !valid {
		t.Error("expected valid cancel signature")
	}
}
