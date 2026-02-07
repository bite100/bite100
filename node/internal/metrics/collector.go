package metrics

import (
	"sync/atomic"
	"time"
)

// Collector 采集 uptime、storage、bytes relayed，供贡献证明使用
type Collector struct {
	StartTime   time.Time     // 节点启动时间
	BytesRelayed atomic.Uint64 // 中继节点：转发的字节数（订阅到的消息长度累加）
	// Storage 由调用方按需查询 data_dir 磁盘占用
}

// NewCollector 创建采集器，StartTime 为当前时间
func NewCollector() *Collector {
	return &Collector{StartTime: time.Now()}
}

// UptimeSeconds 返回已运行秒数
func (c *Collector) UptimeSeconds() int64 {
	return int64(time.Since(c.StartTime).Seconds())
}

// UptimeFraction 返回 uptime 比例 [0,1]，periodSeconds 为周期总秒数（如一周）
func (c *Collector) UptimeFraction(periodSeconds int64) float64 {
	if periodSeconds <= 0 {
		return 0
	}
	up := c.UptimeSeconds()
	if up >= periodSeconds {
		return 1.0
	}
	return float64(up) / float64(periodSeconds)
}

// AddBytesRelayed 增加转发字节数（中继节点收到消息时调用）
func (c *Collector) AddBytesRelayed(n int) {
	if n > 0 {
		c.BytesRelayed.Add(uint64(n))
	}
}

// BytesRelayedTotal 返回累计转发字节数
func (c *Collector) BytesRelayedTotal() uint64 {
	return c.BytesRelayed.Load()
}
