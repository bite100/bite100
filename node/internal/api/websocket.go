package api

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"
	
	"github.com/gorilla/websocket"
	
	"github.com/P2P-P2P/p2p/node/internal/storage"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true  // 生产环境需要验证 origin
	},
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
}

// WSClient WebSocket 客户端
type WSClient struct {
	conn     *websocket.Conn
	send     chan []byte
	server   *WSServer
	lastPong time.Time // 最后收到pong的时间
}

// WSServer WebSocket 服务器
type WSServer struct {
	clients    map[*WSClient]bool
	broadcast  chan []byte
	register   chan *WSClient
	unregister chan *WSClient
	mu         sync.RWMutex
	// 连接管理优化
	maxConnections int
	connectionCount int
	// 消息队列大小限制
	maxMessageQueue int
}

// NewWSServer 创建 WebSocket 服务器
func NewWSServer() *WSServer {
	return &WSServer{
		clients:         make(map[*WSClient]bool),
		broadcast:       make(chan []byte, 256),
		register:        make(chan *WSClient),
		unregister:      make(chan *WSClient),
		maxConnections:  1000, // 最大连接数
		maxMessageQueue: 256,  // 每个客户端最大消息队列
	}
}

// Run 运行 WebSocket 服务器
func (s *WSServer) Run() {
	for {
		select {
		case client := <-s.register:
			s.mu.Lock()
			// 连接管理优化：检查最大连接数
			if s.maxConnections > 0 && len(s.clients) >= s.maxConnections {
				s.mu.Unlock()
				log.Printf("[ws] 连接数已达上限 %d，拒绝新连接", s.maxConnections)
				client.conn.Close()
				continue
			}
			s.clients[client] = true
			s.connectionCount = len(s.clients)
			s.mu.Unlock()
			log.Printf("[ws] 客户端连接，当前: %d/%d", s.connectionCount, s.maxConnections)
			
		case client := <-s.unregister:
			s.mu.Lock()
			if _, ok := s.clients[client]; ok {
				delete(s.clients, client)
				close(client.send)
			}
			s.mu.Unlock()
			log.Printf("[ws] 客户端断开，当前: %d", len(s.clients))
			
		case message := <-s.broadcast:
			s.mu.RLock()
			// 连接管理优化：批量发送，避免阻塞
			clientsToRemove := make([]*WSClient, 0)
			for client := range s.clients {
				select {
				case client.send <- message:
					// 发送成功
				default:
					// 消息队列满，标记为移除
					clientsToRemove = append(clientsToRemove, client)
				}
			}
			s.mu.RUnlock()
			
			// 移除无法发送消息的客户端
			if len(clientsToRemove) > 0 {
				s.mu.Lock()
				for _, client := range clientsToRemove {
					if _, ok := s.clients[client]; ok {
						close(client.send)
						delete(s.clients, client)
					}
				}
				s.connectionCount = len(s.clients)
				s.mu.Unlock()
				log.Printf("[ws] 移除 %d 个无法发送消息的客户端，当前: %d", len(clientsToRemove), s.connectionCount)
			}
		}
	}
}

// BroadcastOrderBookUpdate 广播订单簿更新
func (s *WSServer) BroadcastOrderBookUpdate(pair string, bids, asks []*storage.Order) {
	msg := map[string]interface{}{
		"type": "orderbook_update",
		"pair": pair,
		"data": map[string]interface{}{
			"bids": bids,
			"asks": asks,
		},
	}
	
	jsonData, _ := json.Marshal(msg)
	s.broadcast <- jsonData
}

// BroadcastTrade 广播成交
func (s *WSServer) BroadcastTrade(trade *storage.Trade) {
	msg := map[string]interface{}{
		"type": "trade",
		"data": trade,
	}
	
	jsonData, _ := json.Marshal(msg)
	s.broadcast <- jsonData
}

// BroadcastOrderStatus 广播订单状态更新
func (s *WSServer) BroadcastOrderStatus(order *storage.Order) {
	msg := map[string]interface{}{
		"type": "order_status",
		"data": order,
	}
	
	jsonData, _ := json.Marshal(msg)
	s.broadcast <- jsonData
}

func (c *WSClient) readPump() {
	defer func() {
		c.server.unregister <- c
		c.conn.Close()
	}()
	
	c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		c.lastPong = time.Now()
		c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})
	
	// 连接健康检查：如果60秒内没有收到pong，关闭连接
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			if time.Since(c.lastPong) > 60*time.Second {
				log.Printf("[ws] 客户端健康检查失败，关闭连接")
				c.conn.Close()
				return
			}
		}
	}()
	
	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			break
		}
		
		// 处理客户端消息（如订阅特定交易对）
		var msg map[string]interface{}
		if err := json.Unmarshal(message, &msg); err != nil {
			continue
		}
		
		log.Printf("[ws] 收到消息: %v", msg)
	}
}

func (c *WSClient) writePump() {
	ticker := time.NewTicker(54 * time.Second)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	
	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			
			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}
			
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
