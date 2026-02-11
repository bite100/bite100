package settlement

import (
	"testing"
)

func TestRelayerSelector(t *testing.T) {
	sel := NewRelayerSelector([]string{"http://a", "http://b", "http://c"})
	if sel.Count() != 3 {
		t.Fatalf("Count: got %d want 3", sel.Count())
	}
	seen := make(map[string]bool)
	for i := 0; i < 6; i++ {
		url := sel.GetNext()
		if url == "" {
			t.Fatal("GetNext returned empty")
		}
		seen[url] = true
	}
	if len(seen) != 3 {
		t.Errorf("expected 3 distinct endpoints, got %d", len(seen))
	}
}

func TestRelayerSelector_empty(t *testing.T) {
	sel := NewRelayerSelector(nil)
	if sel.Count() != 0 {
		t.Errorf("Count: got %d want 0", sel.Count())
	}
	if sel.GetNext() != "" {
		t.Error("GetNext should return empty for no endpoints")
	}
}
