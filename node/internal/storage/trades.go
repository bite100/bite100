package storage

import (
	"database/sql"
	"fmt"
	"log"
	"time"
)

// Trade 成交记录（与 Phase2 设计文档一致）
type Trade struct {
	TradeID      string  `json:"tradeId"`
	Pair         string  `json:"pair"`
	TakerOrderID string  `json:"takerOrderId"`
	MakerOrderID string  `json:"makerOrderId"`
	Price        string  `json:"price"`
	Amount       string  `json:"amount"`
	Fee          string  `json:"fee,omitempty"`
	Timestamp    int64   `json:"timestamp"`
	TxHash       string  `json:"txHash,omitempty"`
}

// InsertTrade 插入成交记录
func (db *DB) InsertTrade(t *Trade) error {
	_, err := db.sql.Exec(
		`INSERT OR REPLACE INTO trades (trade_id, pair, taker_order_id, maker_order_id, price, amount, fee, timestamp, tx_hash)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		t.TradeID, t.Pair, t.TakerOrderID, t.MakerOrderID, t.Price, t.Amount, t.Fee, t.Timestamp, t.TxHash,
	)
	return err
}

// InsertTrades 批量插入
func (db *DB) InsertTrades(trades []*Trade) error {
	tx, err := db.sql.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.Prepare(
		`INSERT OR REPLACE INTO trades (trade_id, pair, taker_order_id, maker_order_id, price, amount, fee, timestamp, tx_hash)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, t := range trades {
		_, err := stmt.Exec(t.TradeID, t.Pair, t.TakerOrderID, t.MakerOrderID, t.Price, t.Amount, t.Fee, t.Timestamp, t.TxHash)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ListTrades 按时间范围查询成交，用于 SyncTrades 协议（since/until 为 unix 秒）
func (db *DB) ListTrades(since, until int64, limit int) ([]*Trade, error) {
	if limit <= 0 {
		limit = 1000
	}
	rows, err := db.sql.Query(
		`SELECT trade_id, pair, taker_order_id, maker_order_id, price, amount, fee, timestamp, tx_hash
		 FROM trades WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC LIMIT ?`,
		since, until, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Trade
	for rows.Next() {
		var t Trade
		var taker, maker, fee, txHash sql.NullString
		if err := rows.Scan(&t.TradeID, &t.Pair, &taker, &maker, &t.Price, &t.Amount, &fee, &t.Timestamp, &txHash); err != nil {
			return nil, err
		}
		t.TakerOrderID = taker.String
		t.MakerOrderID = maker.String
		t.Fee = fee.String
		t.TxHash = txHash.String
		out = append(out, &t)
	}
	return out, rows.Err()
}

// DeleteTradesBefore 删除指定时间之前的记录，用于两年保留清理
func (db *DB) DeleteTradesBefore(beforeUnix int64) (int64, error) {
	res, err := db.sql.Exec("DELETE FROM trades WHERE timestamp < ?", beforeUnix)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// TradesWithinRetention 按保留月数裁剪时间范围，超出则裁剪为 now-retentionMonths
func TradesWithinRetention(since, until, now int64, retentionMonths int) (effectiveSince, effectiveUntil int64) {
	retentionSec := int64(retentionMonths) * 30 * 24 * 3600 // 约 30 天/月
	cutoff := now - retentionSec
	effectiveSince = since
	if since < cutoff {
		effectiveSince = cutoff
	}
	effectiveUntil = until
	if until > now {
		effectiveUntil = now
	}
	return effectiveSince, effectiveUntil
}

// SeedTestTrades 插入若干条测试成交，用于 M2 验收（存储节点 -seed-trades）
func (db *DB) SeedTestTrades(n int) (int, error) {
	if n <= 0 {
		n = 5
	}
	now := time.Now().Unix()
	trades := make([]*Trade, n)
	for i := 0; i < n; i++ {
		trades[i] = &Trade{
			TradeID:      fmt.Sprintf("m2-acceptance-test-%d", i),
			Pair:         "TKA/TKB",
			TakerOrderID: fmt.Sprintf("taker-%d", i),
			MakerOrderID: fmt.Sprintf("maker-%d", i),
			Price:        "1.0",
			Amount:       "100",
			Fee:          "0.3",
			Timestamp:    now - int64(i*60),
			TxHash:       fmt.Sprintf("0xseed%d", i),
		}
	}
	if err := db.InsertTrades(trades); err != nil {
		return 0, err
	}
	log.Printf("[seed] 已插入 %d 条测试成交，用于 M2 验收", n)
	return n, nil
}