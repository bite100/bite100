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
	// p2p_match_orders_total 处理的订单总数
	p2pMatchOrdersTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "p2p_match_orders_total",
		Help: "Total number of orders processed",
	})
	// p2p_match_orderbook_size 订单簿大小（按交易对）
	p2pMatchOrderbookSize = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "p2p_match_orderbook_size",
		Help: "Number of orders in orderbook per pair",
	}, []string{"pair", "side"})
	// p2p_match_signature_cache_hits 签名缓存命中次数
	p2pMatchSignatureCacheHits = promauto.NewCounter(prometheus.CounterOpts{
		Name: "p2p_match_signature_cache_hits_total",
		Help: "Total number of signature cache hits",
	})
	// p2p_match_signature_cache_misses 签名缓存未命中次数
	p2pMatchSignatureCacheMisses = promauto.NewCounter(prometheus.CounterOpts{
		Name: "p2p_match_signature_cache_misses_total",
		Help: "Total number of signature cache misses",
	})
)

// RecordMatch 记录撮合结果，用于 Prometheus 指标（TPS 可从 trades_total 推导，延迟用 histogram）
func RecordMatch(tradesCount int, latency time.Duration) {
	if tradesCount > 0 {
		p2pMatchTradesTotal.Add(float64(tradesCount))
	}
	p2pMatchLatencySeconds.Observe(latency.Seconds())
}

// RecordOrderProcessed 记录处理的订单数
func RecordOrderProcessed() {
	p2pMatchOrdersTotal.Inc()
}

// RecordOrderbookSize 记录订单簿大小
func RecordOrderbookSize(pair string, bids, asks int) {
	p2pMatchOrderbookSize.WithLabelValues(pair, "bids").Set(float64(bids))
	p2pMatchOrderbookSize.WithLabelValues(pair, "asks").Set(float64(asks))
}

// RecordSignatureCacheHit 记录签名缓存命中
func RecordSignatureCacheHit() {
	p2pMatchSignatureCacheHits.Inc()
}

// RecordSignatureCacheMiss 记录签名缓存未命中
func RecordSignatureCacheMiss() {
	p2pMatchSignatureCacheMisses.Inc()
}
