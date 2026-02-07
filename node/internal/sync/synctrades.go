package sync

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/protocol"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

const ProtocolID = protocol.ID("/p2p-exchange/sync/trades/1.0.0")

// SyncTradesRequest 请求历史成交
type SyncTradesRequest struct {
	Since int64 `json:"since"` // unix 秒
	Until int64 `json:"until"`
	Limit int   `json:"limit,omitempty"`
}

// SyncTradesResponse 响应
type SyncTradesResponse struct {
	Trades []*storage.Trade `json:"trades"`
}

// Serve 注册 SyncTrades 协议服务端（存储节点调用）
// retentionMonths 为本节点保留期（<=0 表示两周，>0 表示月数），只返回本节点已保留范围内的数据
func Serve(h host.Host, store *storage.DB, retentionMonths int) {
	h.SetStreamHandler(ProtocolID, func(s network.Stream) {
		defer s.Close()
		scanner := bufio.NewScanner(s)
		if !scanner.Scan() {
			return
		}
		var req SyncTradesRequest
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			log.Printf("[SyncTrades] 解析请求失败: %v", err)
			return
		}
		now := time.Now().Unix()
		since, until := storage.TradesWithinRetention(req.Since, req.Until, now, retentionMonths)
		trades, err := store.ListTrades(since, until, req.Limit, "")
		if err != nil {
			log.Printf("[SyncTrades] 查询失败: %v", err)
			return
		}
		resp := SyncTradesResponse{Trades: trades}
		data, err := json.Marshal(resp)
		if err != nil {
			return
		}
		data = append(data, '\n')
		if _, err := s.Write(data); err != nil {
			return
		}
		log.Printf("[SyncTrades] 响应 %s: %d 条成交 (since=%d until=%d)", s.Conn().RemotePeer(), len(trades), since, until)
	})
	log.Printf("SyncTrades 协议已注册: %s", ProtocolID)
}

// Request 向指定 peer 请求历史成交（客户端调用）
// 手机端需超过 1 个月数据时，应向电脑端节点（最多 6 个月）发起请求
func Request(ctx context.Context, h host.Host, peerID peer.ID, since, until int64, limit int) ([]*storage.Trade, error) {
	if limit <= 0 {
		limit = 1000
	}
	s, err := h.NewStream(ctx, peerID, ProtocolID)
	if err != nil {
		return nil, fmt.Errorf("打开 stream: %w", err)
	}
	defer s.Close()
	req := SyncTradesRequest{Since: since, Until: until, Limit: limit}
	data, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	data = append(data, '\n')
	if _, err := s.Write(data); err != nil {
		return nil, err
	}
	scanner := bufio.NewScanner(s)
	if !scanner.Scan() {
		return nil, fmt.Errorf("未收到响应")
	}
	var resp SyncTradesResponse
	if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
		return nil, fmt.Errorf("解析响应: %w", err)
	}
	return resp.Trades, nil
}
