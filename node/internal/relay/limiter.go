package relay

import (
	"sync"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"
)

// Limiter 按 peer 的速率限制（滑动 1 秒窗口）；Phase 3.3
type Limiter struct {
	mu                                    sync.Mutex
	perPeer                               map[peer.ID]*peerWindow
	limitBytesPerSec, limitMsgsPerSec uint64
}

type peerWindow struct {
	windowStart time.Time
	bytes       uint64
	msgs        uint64
}

// NewLimiter 创建限流器；limitBytes 或 limitMsgs 为 0 表示该项不限制
func NewLimiter(limitBytesPerSec, limitMsgsPerSec uint64) *Limiter {
	return &Limiter{
		perPeer:          make(map[peer.ID]*peerWindow),
		limitBytesPerSec: limitBytesPerSec,
		limitMsgsPerSec:  limitMsgsPerSec,
	}
}

// Allow 检查是否允许来自 peer 的 size 字节；若超限返回 false（应丢弃并记违规）
func (l *Limiter) Allow(id peer.ID, size uint64) bool {
	if l.limitBytesPerSec == 0 && l.limitMsgsPerSec == 0 {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	w, ok := l.perPeer[id]
	if !ok {
		w = &peerWindow{windowStart: now}
		l.perPeer[id] = w
	}
	if now.Sub(w.windowStart) >= time.Second {
		w.windowStart = now
		w.bytes = 0
		w.msgs = 0
	}
	if l.limitMsgsPerSec > 0 && w.msgs+1 > l.limitMsgsPerSec {
		return false
	}
	if l.limitBytesPerSec > 0 && w.bytes+size > l.limitBytesPerSec {
		return false
	}
	w.bytes += size
	w.msgs++
	return true
}

// Prune 清理长时间未活动的 peer，避免 map 无限增长
func (l *Limiter) Prune(olderThan time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	cut := time.Now().Add(-olderThan)
	for id, w := range l.perPeer {
		if w.windowStart.Before(cut) {
			delete(l.perPeer, id)
		}
	}
}
