package storage

import (
	"database/sql"
	"fmt"
	"log"
	"time"
)

// Trade 成交记录（与 Phase2/Phase3 设计一致；含结算用 maker/taker/tokenIn/Out/amountIn/Out）
type Trade struct {
	TradeID      string `json:"tradeId"`
	Pair         string `json:"pair"`
	TakerOrderID string `json:"takerOrderId"`
	MakerOrderID string `json:"makerOrderId"`
	Maker        string `json:"maker,omitempty"`   // 结算用
	Taker        string `json:"taker,omitempty"`   // 结算用
	TokenIn      string `json:"tokenIn,omitempty"` // maker 卖出
	TokenOut     string `json:"tokenOut,omitempty"`
	AmountIn     string `json:"amountIn,omitempty"`
	AmountOut    string `json:"amountOut,omitempty"`
	Price        string `json:"price"`
	Amount       string `json:"amount"`
	Fee          string `json:"fee,omitempty"`
	Timestamp    int64  `json:"timestamp"`
	TxHash       string `json:"txHash,omitempty"`
}

// InsertTrade 插入成交记录
func (db *DB) InsertTrade(t *Trade) error {
	_, err := db.sql.Exec(
		`INSERT OR REPLACE INTO trades (trade_id, pair, taker_order_id, maker_order_id, maker, taker, token_in, token_out, amount_in, amount_out, price, amount, fee, timestamp, tx_hash)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		t.TradeID, t.Pair, t.TakerOrderID, t.MakerOrderID, t.Maker, t.Taker, t.TokenIn, t.TokenOut, t.AmountIn, t.AmountOut, t.Price, t.Amount, t.Fee, t.Timestamp, t.TxHash,
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
		`INSERT OR REPLACE INTO trades (trade_id, pair, taker_order_id, maker_order_id, maker, taker, token_in, token_out, amount_in, amount_out, price, amount, fee, timestamp, tx_hash)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, t := range trades {
		_, err := stmt.Exec(t.TradeID, t.Pair, t.TakerOrderID, t.MakerOrderID, t.Maker, t.Taker, t.TokenIn, t.TokenOut, t.AmountIn, t.AmountOut, t.Price, t.Amount, t.Fee, t.Timestamp, t.TxHash)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ListTrades 按时间范围查询成交，用于 SyncTrades 协议（since/until 为 unix 秒）；pair 为空表示不限交易对
func (db *DB) ListTrades(since, until int64, limit int, pair string) ([]*Trade, error) {
	if limit <= 0 {
		limit = 1000
	}
	query := `SELECT trade_id, pair, taker_order_id, maker_order_id, maker, taker, token_in, token_out, amount_in, amount_out, price, amount, fee, timestamp, tx_hash
		 FROM trades WHERE timestamp >= ? AND timestamp <= ?`
	args := []interface{}{since, until}
	if pair != "" {
		query += ` AND pair = ?`
		args = append(args, pair)
	}
	query += ` ORDER BY timestamp DESC LIMIT ?`
	args = append(args, limit)
	rows, err := db.sql.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Trade
	for rows.Next() {
		var t Trade
		var takerOid, makerOid, makerAddr, takerAddr, tokenIn, tokenOut, amountIn, amountOut, fee, txHash sql.NullString
		if err := rows.Scan(&t.TradeID, &t.Pair, &takerOid, &makerOid, &makerAddr, &takerAddr, &tokenIn, &tokenOut, &amountIn, &amountOut, &t.Price, &t.Amount, &fee, &t.Timestamp, &txHash); err != nil {
			return nil, err
		}
		t.TakerOrderID = takerOid.String
		t.MakerOrderID = makerOid.String
		t.Maker = makerAddr.String
		t.Taker = takerAddr.String
		t.TokenIn = tokenIn.String
		t.TokenOut = tokenOut.String
		t.AmountIn = amountIn.String
		t.AmountOut = amountOut.String
		t.Fee = fee.String
		t.TxHash = txHash.String
		out = append(out, &t)
	}
	return out, rows.Err()
}

// DeleteTradesBefore 删除指定时间之前的记录，用于保留期清理（默认两周）
func (db *DB) DeleteTradesBefore(beforeUnix int64) (int64, error) {
	res, err := db.sql.Exec("DELETE FROM trades WHERE timestamp < ?", beforeUnix)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// TradesWithinRetention 按保留期裁剪时间范围；retentionMonths<=0 表示两周（RetentionDaysTwoWeeks），>0 表示月数
func TradesWithinRetention(since, until, now int64, retentionMonths int) (effectiveSince, effectiveUntil int64) {
	var retentionSec int64
	if retentionMonths <= 0 {
		retentionSec = int64(RetentionDaysTwoWeeks) * 24 * 3600
	} else {
		retentionSec = int64(retentionMonths) * 30 * 24 * 3600
	}
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