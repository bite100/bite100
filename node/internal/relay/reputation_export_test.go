package relay

import (
	"testing"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"
)

func TestExportForReputationUpdater(t *testing.T) {
	r := NewReputation()
	pid1 := peer.ID("p1")
	pid2 := peer.ID("p2")
	r.RecordRelayed(pid1, 1000)
	r.RecordRelayed(pid1, 500)
	r.RecordRelayed(pid2, 2000)
	r.RecordViolation(pid2)
	peerToAddr := map[string]string{
		pid1.String(): "0x1111",
		pid2.String(): "0x2222",
	}
	rows := r.ExportForReputationUpdater(peerToAddr, 7*24*time.Hour)
	if len(rows) != 2 {
		t.Fatalf("expected 2 rows, got %d", len(rows))
	}
	for _, row := range rows {
		if row.Address == "" {
			t.Error("address should be set")
		}
		if row.ReputationScore > 10000 {
			t.Errorf("score %d exceeds 10000", row.ReputationScore)
		}
	}
}

func TestExportForReputationUpdater_noMapping(t *testing.T) {
	r := NewReputation()
	rows := r.ExportForReputationUpdater(nil, time.Hour)
	if len(rows) != 0 {
		t.Errorf("expected 0 rows with nil mapping, got %d", len(rows))
	}
}
