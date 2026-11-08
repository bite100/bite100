package match

import (
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/crypto"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// 第 32 轮整改（ChatGPT 审查项）：签名验证缓存键必须绑定订单内容与签名
// 本身，不得再以 orderID 单独做键。以下三路证明互不串扰：
//  1. 同 orderID、篡改金额（签名不变）→ 必须验签失败，不得蹭原单的 true；
//  2. 同 orderID、同字段、换一把钥匙的签名 → 必须失败（摘要相同、签名不同）；
//  3. 原单重复查询仍命中缓存返回 true（缓存本身不回归）。
func TestIsSignatureValid_CacheKeyBindsContentAndSignature(t *testing.T) {
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	otherKey, err := crypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	addr := crypto.PubkeyToAddress(key.PublicKey)
	pairTokens := &PairTokens{Token0: "0x1111111111111111111111111111111111111111", Token1: "0x2222222222222222222222222222222222222222"}

	base := &storage.Order{
		OrderID:   "order_cache_test",
		Trader:    addr.Hex(),
		Pair:      "TKA/TKB",
		Side:      "sell",
		Price:     "2000000000000000000",
		Amount:    "500000000000000000",
		CreatedAt: 1700000000,
		ExpiresAt: 1700086400,
		Nonce:     7,
	}
	sig, err := SignOrder(key, BuildSignedOrder(base, pairTokens))
	if err != nil {
		t.Fatal(err)
	}
	base.Signature = sig

	e := NewEngine(map[string]PairTokens{"TKA/TKB": *pairTokens})

	// 原单：true，且第二次查询走缓存仍为 true。
	for i := 0; i < 2; i++ {
		valid, err := e.IsSignatureValid(base.OrderID, base, pairTokens)
		if err != nil {
			t.Fatalf("IsSignatureValid(original) #%d: %v", i, err)
		}
		if !valid {
			t.Fatalf("IsSignatureValid(original) #%d = false, want true", i)
		}
	}

	// 1) 同 ID 篡改金额、沿用原签名 → false。
	tampered := *base
	tampered.Amount = "600000000000000000"
	valid, err := e.IsSignatureValid(tampered.OrderID, &tampered, pairTokens)
	if err != nil {
		t.Fatalf("IsSignatureValid(tampered): %v", err)
	}
	if valid {
		t.Error("tampered order (same orderID, changed amount) must not reuse cached true")
	}

	// 2) 同 ID 同字段、他人私钥签名 → false（摘要与原单相同，仅签名不同）。
	forged := *base
	forgedSig, err := SignOrder(otherKey, BuildSignedOrder(&forged, pairTokens))
	if err != nil {
		t.Fatal(err)
	}
	forged.Signature = forgedSig
	valid, err = e.IsSignatureValid(forged.OrderID, &forged, pairTokens)
	if err != nil {
		t.Fatalf("IsSignatureValid(forged): %v", err)
	}
	if valid {
		t.Error("forged signature (same digest, different signer) must not reuse cached true")
	}
}

// 第 32 轮整改（ChatGPT 审查项）：订单簿满员改为拒绝新单，且簿内订单与
// orderIDToPair 索引始终一致；同 ID 替换在满员时仍可成功（先腾位再入簿）。
func TestAddOrder_CapacityRejectsNewKeepsIndexConsistent(t *testing.T) {
	e := NewEngine(nil)
	e.maxOrdersPerPair = 3
	now := time.Now().Unix()
	mk := func(id, side string, created int64) *storage.Order {
		return &storage.Order{
			OrderID:   id,
			Trader:    "0x1111111111111111111111111111111111111111",
			Pair:      "TKA/TKB",
			Side:      side,
			Price:     "1000000000000000000",
			Amount:    "1000000000000000000",
			CreatedAt: created,
			ExpiresAt: now + 3600,
		}
	}

	// 买盘恰好装满 3 条。
	for i, id := range []string{"b1", "b2", "b3"} {
		if !e.AddOrder(mk(id, "buy", now+int64(i))) {
			t.Fatalf("AddOrder(%s) = false, want true", id)
		}
	}
	// 第 4 条买单被拒（旧逻辑会静默截掉尾单 b1 并留下脏索引）。
	if e.AddOrder(mk("b4", "buy", now+3)) {
		t.Error("AddOrder(b4) at capacity = true, want false (reject)")
	}
	bids, _ := e.GetOrderbook("TKA/TKB")
	if len(bids) != 3 {
		t.Fatalf("bids len = %d, want 3 (no silent truncation)", len(bids))
	}
	// 索引与簿一致：b1..b3 在索引中、b4 不在。
	for _, id := range []string{"b1", "b2", "b3"} {
		if e.orderIDToPair[id] != "TKA/TKB" {
			t.Errorf("orderIDToPair[%s] = %q, want TKA/TKB", id, e.orderIDToPair[id])
		}
	}
	if _, ok := e.orderIDToPair["b4"]; ok {
		t.Error("orderIDToPair must not contain rejected order b4")
	}
	// 满员时同 ID 替换仍成功，簿长不变、索引保留。
	if !e.AddOrder(mk("b2", "buy", now+10)) {
		t.Error("AddOrder(b2 replacement) at capacity = false, want true")
	}
	bids, _ = e.GetOrderbook("TKA/TKB")
	if len(bids) != 3 {
		t.Fatalf("bids len after replacement = %d, want 3", len(bids))
	}
	if e.orderIDToPair["b2"] != "TKA/TKB" {
		t.Error("orderIDToPair[b2] lost after replacement")
	}

	// 卖盘同口径：装满后新单被拒。
	for i, id := range []string{"a1", "a2", "a3"} {
		if !e.AddOrder(mk(id, "sell", now+int64(i))) {
			t.Fatalf("AddOrder(%s) = false, want true", id)
		}
	}
	if e.AddOrder(mk("a4", "sell", now+3)) {
		t.Error("AddOrder(a4) at capacity = true, want false (reject)")
	}
	if _, ok := e.orderIDToPair["a4"]; ok {
		t.Error("orderIDToPair must not contain rejected order a4")
	}
}
