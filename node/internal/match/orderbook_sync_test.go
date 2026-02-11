package match

import (
	"testing"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

func TestOrdersToLevelSnapshot(t *testing.T) {
	bids := []*storage.Order{
		{OrderID: "b1", Price: "1.0", Amount: "100", Filled: "0"},
		{OrderID: "b2", Price: "1.0", Amount: "50", Filled: "0"},
		{OrderID: "b3", Price: "0.9", Amount: "200", Filled: "0"},
	}
	asks := []*storage.Order{
		{OrderID: "a1", Price: "1.1", Amount: "80", Filled: "0"},
		{OrderID: "a2", Price: "1.2", Amount: "120", Filled: "0"},
	}

	snap := OrdersToLevelSnapshot("TKA/TKB", bids, asks)
	if snap == nil {
		t.Fatal("expected non-nil snapshot")
	}
	if snap.Pair != "TKA/TKB" {
		t.Errorf("pair: got %s", snap.Pair)
	}
	// bids: 1.0 -> 150, 0.9 -> 200; 价格降序
	if len(snap.Bids) != 2 {
		t.Fatalf("bids: expected 2 levels, got %d", len(snap.Bids))
	}
	if snap.Bids[0][0] != "1.0" || snap.Bids[0][1] != "150.000000000000000000" {
		t.Errorf("bids[0]: got [%s,%s]", snap.Bids[0][0], snap.Bids[0][1])
	}
	if snap.Bids[1][0] != "0.9" || snap.Bids[1][1] != "200.000000000000000000" {
		t.Errorf("bids[1]: got [%s,%s]", snap.Bids[1][0], snap.Bids[1][1])
	}
	// asks: 1.1 -> 80, 1.2 -> 120; 价格升序
	if len(snap.Asks) != 2 {
		t.Fatalf("asks: expected 2 levels, got %d", len(snap.Asks))
	}
	if snap.Asks[0][0] != "1.1" || snap.Asks[0][1] != "80.000000000000000000" {
		t.Errorf("asks[0]: got [%s,%s]", snap.Asks[0][0], snap.Asks[0][1])
	}
}

func TestOrdersToLevelSnapshot_empty(t *testing.T) {
	snap := OrdersToLevelSnapshot("TKA/TKB", nil, nil)
	if snap == nil {
		t.Fatal("expected non-nil snapshot for empty orders")
	}
	if len(snap.Bids) != 0 || len(snap.Asks) != 0 {
		t.Errorf("expected empty levels, got bids=%d asks=%d", len(snap.Bids), len(snap.Asks))
	}
}
