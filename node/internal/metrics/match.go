package metrics

import (
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	// p2p_match_trades_total 撮合成交笔数（counter）
	p2pMatchTradesTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "p2p_match_trades_total",
		Help: "Total number of trades matched by the MatchEngine",
	})
	// p2p_match_latency_seconds 单次撮合延迟（秒）
	p2pMatchLatencySeconds = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "p2p_match_latency_seconds",
		Help:    "Match latency in seconds per taker order",
		Buckets: []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1},
	})
)

// RecordMatch 记录撮合结果，用于 Prometheus 指标（TPS 可从 trades_total 推导，延迟用 histogram）
func RecordMatch(tradesCount int, latency time.Duration) {
	if tradesCount > 0 {
		p2pMatchTradesTotal.Add(float64(tradesCount))
	}
	p2pMatchLatencySeconds.Observe(latency.Seconds())
}
