package api

import "testing"

func TestBuildTraderBlacklist(t *testing.T) {
	addrs := []string{
		"0xAbcDEF1234567890",
		" 0xdeadbeef00000000000000000000000000000000 ",
		"",
	}
	m := BuildTraderBlacklist(addrs)
	if m == nil {
		t.Fatalf("expected non-nil map")
	}
	if len(m) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(m))
	}
	if _, ok := m["0xabcdef1234567890"]; !ok {
		t.Errorf("expected normalized key for first address")
	}
	if _, ok := m["0xdeadbeef00000000000000000000000000000000"]; !ok {
		t.Errorf("expected trimmed lowercased key for second address")
	}
}

