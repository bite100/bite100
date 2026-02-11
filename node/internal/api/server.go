// Package api 提供 HTTP API：订单簿、成交、下单/撤单（Phase 3.5 前端）
package api

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/P2P-P2P/p2p/node/internal/match"
	"github.com/P2P-P2P/p2p/node/internal/storage"
	syncpkg "github.com/P2P-P2P/p2p/node/internal/sync"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// cachedResponse 缓存的响应
type cachedResponse struct {
	data      []byte
	timestamp time.Time
}

// orderRateLimiter 按 key（如 IP）滑动窗口限流，用于 API 下单 Spam 防护
type orderRateLimiter struct {
	mu     sync.Mutex
	hits   map[string][]time.Time
	limit  int
	window time.Duration
	// 优化：使用更精确的令牌桶算法
	tokens map[string]*tokenBucket
}

// tokenBucket 令牌桶（用于更精确的限流）
type tokenBucket struct {
	tokens     float64
	lastUpdate time.Time
	capacity   float64
	rate       float64 // tokens per second
}

func newOrderRateLimiter(perMinute int, window time.Duration) *orderRateLimiter {
	if perMinute <= 0 {
		return nil
	}
	return &orderRateLimiter{
		hits:    make(map[string][]time.Time),
		limit:   perMinute,
		window:  window,
		tokens:  make(map[string]*tokenBucket),
	}
}

// allowTokenBucket 使用令牌桶算法检查是否允许请求
func (l *orderRateLimiter) allowTokenBucket(key string) bool {
	if l == nil {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	
	now := time.Now()
	bucket, ok := l.tokens[key]
	if !ok {
		// 初始化令牌桶：容量为limit，速率为limit/window
		bucket = &tokenBucket{
			tokens:     float64(l.limit),
			lastUpdate: now,
			capacity:   float64(l.limit),
			rate:       float64(l.limit) / window.Seconds(),
		}
		l.tokens[key] = bucket
	}
	
	// 补充令牌
	elapsed := now.Sub(bucket.lastUpdate).Seconds()
	bucket.tokens = bucket.tokens + elapsed*bucket.rate
	if bucket.tokens > bucket.capacity {
		bucket.tokens = bucket.capacity
	}
	bucket.lastUpdate = now
	
	// 检查是否有足够的令牌
	if bucket.tokens >= 1.0 {
		bucket.tokens -= 1.0
		return true
	}
	return false
}

// MaskIP 脱敏 IP，用于日志输出（不记录完整 IP 策略）
func MaskIP(ip string) string {
	if ip == "" {
		return ""
	}
	// IPv4: 192.168.1.100 -> 192.168.1.xxx
	if idx := strings.LastIndex(ip, "."); idx > 0 && idx < len(ip)-1 {
		return ip[:idx+1] + "xxx"
	}
	// IPv6 或异常：取前几位 + xxx
	if len(ip) > 8 {
		return ip[:8] + "..."
	}
	return "xxx"
}

func remoteIP(r *http.Request) string {
	if x := r.Header.Get("X-Forwarded-For"); x != "" {
		if i := strings.Index(x, ","); i > 0 {
			x = strings.TrimSpace(x[:i])
		} else {
			x = strings.TrimSpace(x)
		}
		if x != "" {
			return x
		}
	}
	if x := r.Header.Get("X-Real-IP"); x != "" {
		return strings.TrimSpace(x)
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	if host != "" {
		return host
	}
	return r.RemoteAddr
}

func (l *orderRateLimiter) Allow(key string) bool {
	if l == nil {
		return true
	}
	// 优化：优先使用令牌桶算法（更精确）
	if l.allowTokenBucket(key) {
		// 同时更新滑动窗口（用于兼容）
		l.mu.Lock()
		now := time.Now()
		cut := now.Add(-l.window)
		slice := l.hits[key]
		i := 0
		for i < len(slice) && slice[i].Before(cut) {
			i++
		}
		slice = slice[i:]
		l.hits[key] = append(slice, now)
		l.mu.Unlock()
		return true
	}
	return false
}

// Server HTTP API 服务
type Server struct {
	Store                   *storage.DB
	MatchEngine              *match.Engine
	Publish                  func(topic string, data []byte) error
	NodeType                 string // storage | relay | match，用于前端展示
	RewardWallet             string // 领奖地址（VPS/Docker 下由 env REWARD_WALLET 配置，仅展示）
	WSServer                 *WSServer // WebSocket 服务器
	RateLimitOrdersPerMinute uint64    // 每 IP 每分钟下单上限，0=不限制（Spam 防护）
	BlockedTraders           map[string]struct{} // 黑名单：拒绝这些地址下单（Spam 防护；从 config api.blocked_traders 构建）
	orderLimiter              *orderRateLimiter
	// 响应缓存优化
	responseCache            map[string]*cachedResponse
	cacheMu                  sync.RWMutex
	cacheTTL                 time.Duration
	// API响应时间监控
	responseTimeHistogram    map[string][]time.Duration
}

// BuildTraderBlacklist 从配置构建 trader 黑名单 map（地址统一小写）；用于 Spam 防护
func BuildTraderBlacklist(addrs []string) map[string]struct{} {
	if len(addrs) == 0 {
		return nil
	}
	m := make(map[string]struct{}, len(addrs))
	for _, a := range addrs {
		a = strings.TrimSpace(a)
		if a != "" {
			m[strings.ToLower(a)] = struct{}{}
		}
	}
	if len(m) == 0 {
		return nil
	}
	return m
}

// OrderbookResponse 订单簿 GET 响应
type OrderbookResponse struct {
	Pair string           `json:"pair"`
	Bids []*storage.Order `json:"bids"`
	Asks []*storage.Order `json:"asks"`
}

// Run 启动 HTTP 服务；若 listen 为空则不启动
func (s *Server) Run(listen string) {
	if listen == "" {
		return
	}
	// 节点启动时从存储恢复订单簿（清单 1.1 节点重启后订单簿同步）
	if s.Store != nil && s.MatchEngine != nil {
		if err := match.RestoreOrdersFromStore(s.MatchEngine, s.Store); err != nil {
			log.Printf("[api] 订单簿恢复失败: %v", err)
		}
	}
	if s.RateLimitOrdersPerMinute > 0 {
		s.orderLimiter = newOrderRateLimiter(int(s.RateLimitOrdersPerMinute), time.Minute)
		log.Printf("[api] 下单速率限制: 每 IP 每分钟 %d 笔", s.RateLimitOrdersPerMinute)
	}
	// 初始化 WebSocket 服务器
	if s.WSServer == nil {
		s.WSServer = NewWSServer()
		go s.WSServer.Run()
	}
	
	// 初始化响应缓存
	if s.responseCache == nil {
		s.responseCache = make(map[string]*cachedResponse)
		s.cacheTTL = 5 * time.Second // 默认5秒缓存
		s.responseTimeHistogram = make(map[string][]time.Duration)
	}
	
	// 定期清理过期缓存
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			s.cleanExpiredCache()
		}
	}()
	
	mux := http.NewServeMux()
	mux.HandleFunc("/api/orderbook", s.cors(s.handleOrderbook))
	mux.HandleFunc("/api/trades", s.cors(s.handleTrades))
	mux.HandleFunc("/api/orders", s.cors(s.handleOrders))
	mux.HandleFunc("/api/order", s.cors(s.handlePostOrder))
	mux.HandleFunc("/api/order/cancel", s.cors(s.handleCancelOrder))
	mux.HandleFunc("/api/health", s.cors(s.handleHealth))
	mux.HandleFunc("/api/node", s.cors(s.handleNode))
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/ws", s.handleWebSocket)
	srv := &http.Server{Addr: listen, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	log.Printf("[api] 监听 %s (含 WebSocket)", listen)
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("[api] 服务错误: %v", err)
		}
	}()
}

func (s *Server) cors(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		// API响应时间监控
		start := time.Now()
		next(w, r)
		duration := time.Since(start)
		s.recordResponseTime(r.URL.Path, duration)
	}
}

// recordResponseTime 记录API响应时间
func (s *Server) recordResponseTime(path string, duration time.Duration) {
	if s.responseTimeHistogram == nil {
		return
	}
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	if s.responseTimeHistogram[path] == nil {
		s.responseTimeHistogram[path] = make([]time.Duration, 0, 100)
	}
	s.responseTimeHistogram[path] = append(s.responseTimeHistogram[path], duration)
	// 只保留最近100条记录
	if len(s.responseTimeHistogram[path]) > 100 {
		s.responseTimeHistogram[path] = s.responseTimeHistogram[path][len(s.responseTimeHistogram[path])-100:]
	}
}

// cleanExpiredCache 清理过期缓存
func (s *Server) cleanExpiredCache() {
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	now := time.Now()
	for key, cached := range s.responseCache {
		if now.Sub(cached.timestamp) > s.cacheTTL {
			delete(s.responseCache, key)
		}
	}
}

// getCachedResponse 获取缓存的响应
func (s *Server) getCachedResponse(key string) []byte {
	s.cacheMu.RLock()
	defer s.cacheMu.RUnlock()
	cached, ok := s.responseCache[key]
	if !ok {
		return nil
	}
	if time.Since(cached.timestamp) > s.cacheTTL {
		return nil
	}
	return cached.data
}

// setCachedResponse 设置缓存的响应
func (s *Server) setCachedResponse(key string, data []byte) {
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	s.responseCache[key] = &cachedResponse{
		data:      data,
		timestamp: time.Now(),
	}
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
}

func (s *Server) handleNode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	nodeType := s.NodeType
	if nodeType == "" {
		nodeType = "relay"
	}
	out := map[string]string{"nodeType": nodeType}
	if s.RewardWallet != "" {
		out["rewardWallet"] = s.RewardWallet
	}
	_ = json.NewEncoder(w).Encode(out)
}

func (s *Server) handleOrderbook(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pair := r.URL.Query().Get("pair")
	if pair == "" {
		http.Error(w, "pair required", http.StatusBadRequest)
		return
	}
	
	// 响应缓存优化：检查缓存
	cacheKey := "orderbook:" + pair
	if cached := s.getCachedResponse(cacheKey); cached != nil {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Cache", "HIT")
		_, _ = w.Write(cached)
		return
	}
	
	var bids, asks []*storage.Order
	if s.MatchEngine != nil {
		bids, asks = s.MatchEngine.GetOrderbook(pair)
	}
	if (bids == nil && asks == nil) && s.Store != nil {
		var err error
		bids, asks, err = s.Store.ListOrdersOpenByPair(pair, 100)
		if err != nil {
			log.Printf("[api] orderbook: %v", err)
			http.Error(w, "db error", http.StatusInternalServerError)
			return
		}
	}
	
	response := OrderbookResponse{Pair: pair, Bids: bids, Asks: asks}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Cache", "MISS")
	
	// 编码并缓存响应
	var buf []byte
	if data, err := json.Marshal(response); err == nil {
		buf = data
		s.setCachedResponse(cacheKey, data)
		_, _ = w.Write(data)
	} else {
		http.Error(w, "encode error", http.StatusInternalServerError)
	}
}

func (s *Server) handleTrades(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.Store == nil {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]*storage.Trade{})
		return
	}
	pair := r.URL.Query().Get("pair")
	limitStr := r.URL.Query().Get("limit")
	limit := 50
	if limitStr != "" {
		if n, err := strconv.Atoi(limitStr); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	now := time.Now().Unix()
	since := now - 86400*7 // 最近 7 天
	trades, err := s.Store.ListTrades(since, now, limit, pair)
	if err != nil {
		log.Printf("[api] trades: %v", err)
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(trades)
}

func (s *Server) handleOrders(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.Store == nil {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]*storage.Order{})
		return
	}
	trader := r.URL.Query().Get("trader")
	pair := r.URL.Query().Get("pair")
	limitStr := r.URL.Query().Get("limit")
	limit := 50
	if limitStr != "" {
		if n, err := strconv.Atoi(limitStr); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	orders, err := s.Store.ListOrdersByTrader(trader, pair, limit)
	if err != nil {
		log.Printf("[api] orders: %v", err)
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(orders)
}

func (s *Server) handlePostOrder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.Publish == nil {
		http.Error(w, "publish not configured", http.StatusServiceUnavailable)
		return
	}
	// Spam 防护：按 IP 速率限制（IP 仅存内存，不持久化，见 docs/隐私与不记录IP策略.md）
	if s.orderLimiter != nil {
		ip := remoteIP(r)
		if !s.orderLimiter.Allow(ip) {
			log.Printf("[api] 下单速率超限（来源已脱敏）: %s", MaskIP(ip))
			http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
	}
	
	// 错误处理优化：使用defer恢复panic
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[api] handlePostOrder panic: %v", r)
			http.Error(w, "internal server error", http.StatusInternalServerError)
		}
	}()
	var o storage.Order
	if err := json.NewDecoder(r.Body).Decode(&o); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if o.OrderID == "" || o.Pair == "" || o.Side == "" || o.Price == "" || o.Amount == "" {
		http.Error(w, "missing required fields", http.StatusBadRequest)
		return
	}
	// Spam 防护：黑名单 trader 拒绝
	if s.BlockedTraders != nil {
		if _, blocked := s.BlockedTraders[strings.ToLower(o.Trader)]; blocked {
			http.Error(w, "trader blocked", http.StatusForbidden)
			return
		}
	}
	if o.Signature == "" {
		http.Error(w, "signature required", http.StatusBadRequest)
		return
	}
	// Replay/过期防护：拒绝已过期订单
	if storage.OrderExpired(&o) {
		http.Error(w, "order expired", http.StatusBadRequest)
		return
	}
	// 验证订单签名（EIP-712，与前端 orderSigning 一致）
	{
		var pairTokens *match.PairTokens
		if s.MatchEngine != nil {
			pairTokens = s.MatchEngine.GetPairTokens(o.Pair)
		}
		valid, err := match.VerifyOrderSignature(&o, pairTokens)
		if err != nil {
			log.Printf("[api] 签名验证错误: %v", err)
			http.Error(w, "signature verification error", http.StatusBadRequest)
			return
		}
		if !valid {
			http.Error(w, "invalid signature", http.StatusUnauthorized)
			return
		}
	}
	data, err := json.Marshal(&o)
	if err != nil {
		http.Error(w, "encode error", http.StatusInternalServerError)
		return
	}
	if err := s.Publish(syncpkg.TopicOrderNew, data); err != nil {
		log.Printf("[api] publish order: %v", err)
		http.Error(w, "publish failed", http.StatusInternalServerError)
		return
	}
	
	// 广播订单状态到 WebSocket 客户端
	if s.WSServer != nil {
		s.WSServer.BroadcastOrderStatus(&o)
	}
	
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true,"orderId":"` + o.OrderID + `"}`))
}

func (s *Server) handleCancelOrder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.Publish == nil {
		http.Error(w, "publish not configured", http.StatusServiceUnavailable)
		return
	}
	var req syncpkg.CancelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if req.OrderID == "" {
		http.Error(w, "orderId required", http.StatusBadRequest)
		return
	}
	
	// 验证取消订单签名（如果提供了签名和用户地址）；同时检查黑名单
	if s.Store != nil {
		order, err := s.Store.GetOrder(req.OrderID)
		if err == nil && order != nil {
			// Spam 防护：黑名单 trader 拒绝撤单
			if s.BlockedTraders != nil {
				if _, blocked := s.BlockedTraders[strings.ToLower(order.Trader)]; blocked {
					http.Error(w, "trader blocked", http.StatusForbidden)
					return
				}
			}
		}
	}
	if req.Signature != "" {
		// 需要从订单中获取用户地址
		if s.Store != nil {
			order, err := s.Store.GetOrder(req.OrderID)
			if err == nil && order != nil {
				timestamp := req.Timestamp
				if timestamp == 0 {
					timestamp = time.Now().Unix()
				}
				valid, err := match.VerifyCancelSignature(req.OrderID, order.Trader, req.Signature, timestamp)
				if err != nil {
					log.Printf("[api] 取消签名验证错误: %v", err)
					http.Error(w, "signature verification error", http.StatusBadRequest)
					return
				}
				if !valid {
					http.Error(w, "invalid signature", http.StatusUnauthorized)
					return
				}
			}
		}
	}
	data, err := json.Marshal(&req)
	if err != nil {
		http.Error(w, "encode error", http.StatusInternalServerError)
		return
	}
	if err := s.Publish(syncpkg.TopicOrderCancel, data); err != nil {
		log.Printf("[api] publish cancel: %v", err)
		http.Error(w, "publish failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[ws] 升级失败: %v", err)
		return
	}
	
	client := &WSClient{
		conn:   conn,
		send:   make(chan []byte, 256),
		server: s.WSServer,
	}
	
	s.WSServer.register <- client
	
	// 启动读写协程
	go client.writePump()
	go client.readPump()
}
