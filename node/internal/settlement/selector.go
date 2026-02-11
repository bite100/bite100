package settlement

import (
	"sync"
)

// RelayerSelector §12.3 多 Relayer：按轮询选择 relayer 端点，避免单点
type RelayerSelector struct {
	mu        sync.Mutex
	endpoints []string
	idx       int
}

// NewRelayerSelector 创建轮询选择器
func NewRelayerSelector(endpoints []string) *RelayerSelector {
	// 过滤空字符串
	list := make([]string, 0, len(endpoints))
	for _, e := range endpoints {
		if e != "" {
			list = append(list, e)
		}
	}
	return &RelayerSelector{endpoints: list}
}

// GetNext 返回下一个端点（轮询）；若无端点返回空字符串
func (r *RelayerSelector) GetNext() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.endpoints) == 0 {
		return ""
	}
	url := r.endpoints[r.idx]
	r.idx = (r.idx + 1) % len(r.endpoints)
	return url
}

// Count 返回端点数量
func (r *RelayerSelector) Count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.endpoints)
}
