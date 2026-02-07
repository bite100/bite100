package relay

import (
	"sync"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"
)

// PeerStats 单 peer 信誉相关统计（Phase 3.3 抗 Sybil 基础）
type PeerStats struct {
	BytesRelayed uint64
	Violations   uint64
	LastSeen     time.Time
}

// Reputation 按 peer 记录转发量与违规次数，供限流降权或踢出使用
type Reputation struct {
	mu   sync.RWMutex
	peer map[peer.ID]*PeerStats
}

// NewReputation 创建信誉表
func NewReputation() *Reputation {
	return &Reputation{peer: make(map[peer.ID]*PeerStats)}
}

// RecordRelayed 记录该 peer 正常转发
func (r *Reputation) RecordRelayed(id peer.ID, bytes uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.peer[id] == nil {
		r.peer[id] = &PeerStats{}
	}
	r.peer[id].BytesRelayed += bytes
	r.peer[id].LastSeen = time.Now()
}

// RecordViolation 记录该 peer 违规（如超限被丢弃）
func (r *Reputation) RecordViolation(id peer.ID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.peer[id] == nil {
		r.peer[id] = &PeerStats{}
	}
	r.peer[id].Violations++
	r.peer[id].LastSeen = time.Now()
}

// Get 返回 peer 统计（只读）
func (r *Reputation) Get(id peer.ID) (bytes uint64, violations uint64, lastSeen time.Time) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if s := r.peer[id]; s != nil {
		return s.BytesRelayed, s.Violations, s.LastSeen
	}
	return 0, 0, time.Time{}
}

// Snapshot 返回所有 peer 的统计快照（用于日志或导出）
func (r *Reputation) Snapshot() map[peer.ID]PeerStats {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make(map[peer.ID]PeerStats, len(r.peer))
	for id, s := range r.peer {
		out[id] = *s
	}
	return out
}

// Prune 移除长时间未见的 peer
func (r *Reputation) Prune(olderThan time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	cut := time.Now().Add(-olderThan)
	for id, s := range r.peer {
		if s.LastSeen.Before(cut) {
			delete(r.peer, id)
		}
	}
}
