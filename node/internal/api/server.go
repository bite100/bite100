// Package api 提供 HTTP API：订单簿、成交、下单/撤单（Phase 3.5 前端）
package api

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/P2P-P2P/p2p/node/internal/match"
	"github.com/P2P-P2P/p2p/node/internal/storage"
	"github.com/P2P-P2P/p2p/node/internal/sync"
)

// Server HTTP API 服务
type Server struct {
	Store       *storage.DB
	MatchEngine *match.Engine
	Publish     func(topic string, data []byte) error
	NodeType    string // storage | relay | match，用于前端展示
	WSServer    *WSServer // WebSocket 服务器
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
	
	// 初始化 WebSocket 服务器
	if s.WSServer == nil {
		s.WSServer = NewWSServer()
		go s.WSServer.Run()
	}
	
	mux := http.NewServeMux()
	mux.HandleFunc("/api/orderbook", s.cors(s.handleOrderbook))
	mux.HandleFunc("/api/trades", s.cors(s.handleTrades))
	mux.HandleFunc("/api/orders", s.cors(s.handleOrders))
	mux.HandleFunc("/api/order", s.cors(s.handlePostOrder))
	mux.HandleFunc("/api/order/cancel", s.cors(s.handleCancelOrder))
	mux.HandleFunc("/api/health", s.cors(s.handleHealth))
	mux.HandleFunc("/api/node", s.cors(s.handleNode))
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
		next(w, r)
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
	_, _ = w.Write([]byte(`{"nodeType":"` + nodeType + `"}`))
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
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(OrderbookResponse{Pair: pair, Bids: bids, Asks: asks})
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
	var o storage.Order
	if err := json.NewDecoder(r.Body).Decode(&o); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if o.OrderID == "" || o.Pair == "" || o.Side == "" || o.Price == "" || o.Amount == "" {
		http.Error(w, "missing required fields", http.StatusBadRequest)
		return
	}
	
	// 验证订单签名（如果提供了签名）
	if o.Signature != "" {
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
	if err := s.Publish(sync.TopicOrderNew, data); err != nil {
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
	var req sync.CancelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if req.OrderID == "" {
		http.Error(w, "orderId required", http.StatusBadRequest)
		return
	}
	
	// 验证取消订单签名（如果提供了签名和用户地址）
	if req.Signature != "" {
		// 需要从订单中获取用户地址，这里简化处理，实际应从订单存储中查询
		// 如果订单不存在或无法获取用户地址，跳过签名验证（向后兼容）
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
	if err := s.Publish(sync.TopicOrderCancel, data); err != nil {
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
