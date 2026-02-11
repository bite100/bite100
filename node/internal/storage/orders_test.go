package storage

import (
	"testing"
	"time"
)

// TestOrderExpired Replay Attack 防护：验证订单过期判断（6.1）
func TestOrderExpired(t *testing.T) {
	now := time.Now().Unix()
	past := now - 3600
	future := now + 3600

	if OrderExpired(nil) {
		t.Error("nil order should not be expired")
	}
	if OrderExpired(&Order{ExpiresAt: 0}) {
		t.Error("ExpiresAt=0 (永不过期) should not be expired")
	}
	if !OrderExpired(&Order{ExpiresAt: past}) {
		t.Error("ExpiresAt in past should be expired")
	}
	if OrderExpired(&Order{ExpiresAt: future}) {
		t.Error("ExpiresAt in future should not be expired")
	}
}

func TestListPairsWithOpenOrders(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// 插入 open/partial 订单
	orders := []*Order{
		{OrderID: "o1", Trader: "0x1", Pair: "TKA/TKB", Side: "buy", Price: "1", Amount: "100", Filled: "0", Status: "open", Nonce: 1, CreatedAt: 1, ExpiresAt: 0},
		{OrderID: "o2", Trader: "0x2", Pair: "TKA/TKB", Side: "sell", Price: "1.1", Amount: "50", Filled: "0", Status: "partial", Nonce: 2, CreatedAt: 2, ExpiresAt: 0},
		{OrderID: "o3", Trader: "0x3", Pair: "TKC/TKD", Side: "buy", Price: "2", Amount: "200", Filled: "0", Status: "open", Nonce: 3, CreatedAt: 3, ExpiresAt: 0},
		{OrderID: "o4", Trader: "0x4", Pair: "TKA/TKB", Side: "buy", Price: "0.9", Amount: "10", Filled: "10", Status: "filled", Nonce: 4, CreatedAt: 4, ExpiresAt: 0},
	}
	for _, o := range orders {
		if err := db.InsertOrder(o); err != nil {
			t.Fatal(err)
		}
	}

	pairs, err := db.ListPairsWithOpenOrders()
	if err != nil {
		t.Fatal(err)
	}
	// 应有 TKA/TKB 和 TKC/TKD（filled 不计入）
	if len(pairs) != 2 {
		t.Errorf("expected 2 pairs, got %d: %v", len(pairs), pairs)
	}
	// 按 pair 排序，应为 TKA/TKB, TKC/TKD
	expected := []string{"TKA/TKB", "TKC/TKD"}
	for i, p := range pairs {
		if i >= len(expected) || p != expected[i] {
			t.Errorf("pairs[%d] = %q, want %q", i, p, expected[i])
		}
	}
}
