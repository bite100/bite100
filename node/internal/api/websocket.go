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
	conn   *websocket.Conn
	send   chan []byte
	server *WSServer
}

// WSServer WebSocket 服务器
type WSServer struct {
	clients    map[*WSClient]bool
	broadcast  chan []byte
	register   chan *WSClient
	unregister chan *WSClient
	mu         sync.RWMutex
}

// NewWSServer 创建 WebSocket 服务器
func NewWSServer() *WSServer {
	return &WSServer{
		clients:    make(map[*WSClient]bool),
		broadcast:  make(chan []byte, 256),
		register:   make(chan *WSClient),
		unregister: make(chan *WSClient),
	}
}

// Run 运行 WebSocket 服务器
func (s *WSServer) Run() {
	for {
		select {
		case client := <-s.register:
			s.mu.Lock()
			s.clients[client] = true
			s.mu.Unlock()
			log.Printf("[ws] 客户端连接，当前: %d", len(s.clients))
			
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
			for client := range s.clients {
				select {
				case client.send <- message:
				default:
					close(client.send)
					delete(s.clients, client)
				}
			}
			s.mu.RUnlock()
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
		c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})
	
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
