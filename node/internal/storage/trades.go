package storage

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"time"
)

// SignedOrder 与合约 Settlement.SignedOrder 对齐的签名订单（EIP-712 统一规范，见 docs/eip712-order-spec.md）。
// AmountIn/AmountOut/Price 为最小单位整数的十进制字符串（Price 为 1e18 定点缩放）。
type SignedOrder struct {
	OrderID     string `json:"orderId"`
	UserAddress string `json:"userAddress"`
	TokenIn     string `json:"tokenIn"`
	TokenOut    string `json:"tokenOut"`
	AmountIn    string `json:"amountIn"`
	AmountOut   string `json:"amountOut"`
	Price       string `json:"price"`
	Timestamp   int64  `json:"timestamp"`
	ExpiresAt   int64  `json:"expiresAt"`
	Nonce       int64  `json:"nonce"`
	Signature   string `json:"signature"`
}

// 成交结算状态机（第二十六轮）：节点内结算提交器的幂等账本。
// pending → submitting（原子领取）→ settled / retry（瞬时失败待重试）/ failed（确定性失败终态）。
// submitting 是进程崩溃的恢复点：重启时先对账（链上 filled 核查）再重置为 pending。
const (
	SettlePending    = "pending"
	SettleSubmitting = "submitting"
	SettleRetry      = "retry"
	SettleSettled    = "settled"
	SettleFailed     = "failed"
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
	// MakerOrder/TakerOrder 为双方的完整签名订单（撮合时由引擎填充），链上验签结算必需。
	// 不走 JSON 线格式（gossip/API 维持旧口径），但自第二十六轮起以 maker_order/
	// taker_order 列落库——进程重启后启动清扫重建 Fill 全靠它们（或按订单 ID 从
	// orders 表以 match.BuildSignedOrder 重建，二者同源等价）。
	MakerOrder *SignedOrder `json:"-"`
	TakerOrder *SignedOrder `json:"-"`
	// 结算状态机（第二十六轮，见上方常量）；SettleError 记录最近一次失败原因
	// 或终态说明（如「已在链上核实落账」时 tx 未知的原因）。
	SettleStatus   string `json:"settleStatus,omitempty"`
	SettleError    string `json:"settleError,omitempty"`
	SettleAttempts int    `json:"settleAttempts,omitempty"`
}

// tradeColumns 统一列清单（读写共用，保证扫描口径一致）
const tradeColumns = `trade_id, pair, taker_order_id, maker_order_id, maker, taker, token_in, token_out, amount_in, amount_out, price, amount, fee, timestamp, tx_hash, maker_order, taker_order, settle_status, settle_error, settle_attempts`

// upsertTradeSQL 插入成交；冲突（同一 trade_id 重复落库，如 gossip 回声、撮合与
// 同步路径双写）时只刷新行情字段与签名订单 JSON，绝不覆盖结算状态机与
// tx_hash——结算进度只能由 MarkTradeSettle* 推进，这是提交器幂等的地基。
const upsertTradeSQL = `INSERT INTO trades (` + tradeColumns + `)
	 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	 ON CONFLICT(trade_id) DO UPDATE SET
		pair = excluded.pair,
		taker_order_id = excluded.taker_order_id,
		maker_order_id = excluded.maker_order_id,
		maker = excluded.maker,
		taker = excluded.taker,
		token_in = excluded.token_in,
		token_out = excluded.token_out,
		amount_in = excluded.amount_in,
		amount_out = excluded.amount_out,
		price = excluded.price,
		amount = excluded.amount,
		fee = excluded.fee,
		timestamp = excluded.timestamp,
		maker_order = COALESCE(excluded.maker_order, trades.maker_order),
		taker_order = COALESCE(excluded.taker_order, trades.taker_order)`

func marshalSignedOrder(so *SignedOrder) interface{} {
	if so == nil {
		return nil
	}
	b, err := json.Marshal(so)
	if err != nil {
		return nil
	}
	return string(b)
}

func unmarshalSignedOrder(s sql.NullString) *SignedOrder {
	if !s.Valid || s.String == "" {
		return nil
	}
	var so SignedOrder
	if err := json.Unmarshal([]byte(s.String), &so); err != nil {
		return nil
	}
	return &so
}

// tradeArgs 组装 upsert 参数。新行的结算状态：调用方显式给定时尊重之；否则带
// tx_hash 的行（如种子数据）视为已结算，其余为 pending 待提交器接管。
func tradeArgs(t *Trade) []interface{} {
	status := t.SettleStatus
	if status == "" {
		if t.TxHash != "" {
			status = SettleSettled
		} else {
			status = SettlePending
		}
	}
	return []interface{}{
		t.TradeID, t.Pair, t.TakerOrderID, t.MakerOrderID, t.Maker, t.Taker, t.TokenIn, t.TokenOut,
		t.AmountIn, t.AmountOut, t.Price, t.Amount, t.Fee, t.Timestamp, t.TxHash,
		marshalSignedOrder(t.MakerOrder), marshalSignedOrder(t.TakerOrder),
		status, t.SettleError, t.SettleAttempts,
	}
}

type tradeScanner interface {
	Scan(dest ...interface{}) error
}

func scanTrade(s tradeScanner) (*Trade, error) {
	var t Trade
	var takerOid, makerOid, makerAddr, takerAddr, tokenIn, tokenOut, amountIn, amountOut, fee, txHash sql.NullString
	var makerOrderJSON, takerOrderJSON, settleStatus, settleError sql.NullString
	var settleAttempts sql.NullInt64
	if err := s.Scan(&t.TradeID, &t.Pair, &takerOid, &makerOid, &makerAddr, &takerAddr, &tokenIn, &tokenOut, &amountIn, &amountOut, &t.Price, &t.Amount, &fee, &t.Timestamp, &txHash, &makerOrderJSON, &takerOrderJSON, &settleStatus, &settleError, &settleAttempts); err != nil {
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
	t.MakerOrder = unmarshalSignedOrder(makerOrderJSON)
	t.TakerOrder = unmarshalSignedOrder(takerOrderJSON)
	t.SettleStatus = settleStatus.String
	t.SettleError = settleError.String
	t.SettleAttempts = int(settleAttempts.Int64)
	return &t, nil
}

// InsertTrade 插入成交记录（重复落库不回滚结算状态，见 upsertTradeSQL）
func (db *DB) InsertTrade(t *Trade) error {
	_, err := db.sql.Exec(upsertTradeSQL, tradeArgs(t)...)
	return err
}

// InsertTrades 批量插入
func (db *DB) InsertTrades(trades []*Trade) error {
	tx, err := db.sql.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.Prepare(upsertTradeSQL)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, t := range trades {
		if _, err := stmt.Exec(tradeArgs(t)...); err != nil {
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
	query := `SELECT ` + tradeColumns + `
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
		t, err := scanTrade(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// ---------- 第二十六轮：结算提交队列（供 internal/settlement.Submitter 使用） ----------

// GetTradeByID 按 trade_id 查询单笔成交（含签名订单与结算状态）
func (db *DB) GetTradeByID(tradeID string) (*Trade, error) {
	row := db.sql.QueryRow(`SELECT `+tradeColumns+` FROM trades WHERE trade_id = ?`, tradeID)
	t, err := scanTrade(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return t, nil
}

// ListTradesForSettlement 返回待提交器处理的成交：状态 pending/retry 且尚无
// tx_hash（带 tx_hash 的行无论状态一律视为已落账，排除种子/历史数据），按
// 时间升序——提交顺序与撮合顺序一致，运营密钥的链上 nonce 天然有序。
func (db *DB) ListTradesForSettlement(limit int) ([]*Trade, error) {
	if limit <= 0 {
		limit = 500
	}
	rows, err := db.sql.Query(
		`SELECT `+tradeColumns+` FROM trades
		 WHERE settle_status IN (?, ?) AND (tx_hash IS NULL OR tx_hash = '')
		 ORDER BY timestamp ASC LIMIT ?`,
		SettlePending, SettleRetry, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Trade
	for rows.Next() {
		t, err := scanTrade(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// ListTradesByOrder 返回某订单参与的全部成交（不限结算状态）：订单已成交量
// 的唯一事实源。成交量一旦撮合即消耗，与结算状态无关——结算失败的成交
// 同样占了量，绝不能因为结算失败就把量还给订单簿（第二十六轮补丁）。
func (db *DB) ListTradesByOrder(orderID string) ([]*Trade, error) {
	rows, err := db.sql.Query(
		`SELECT `+tradeColumns+` FROM trades
		 WHERE maker_order_id = ? OR taker_order_id = ?
		 ORDER BY timestamp ASC`,
		orderID, orderID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Trade
	for rows.Next() {
		t, err := scanTrade(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// ListSettledTradesByOrder 返回某订单参与的、本地已记 settled 的全部成交
// （提交器据此与链上 orderFilled 对账，判断一笔崩溃中丢失的提交是否已落账）
func (db *DB) ListSettledTradesByOrder(orderID string) ([]*Trade, error) {
	rows, err := db.sql.Query(
		`SELECT `+tradeColumns+` FROM trades
		 WHERE settle_status = ? AND (maker_order_id = ? OR taker_order_id = ?)
		 ORDER BY timestamp ASC`,
		SettleSettled, orderID, orderID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Trade
	for rows.Next() {
		t, err := scanTrade(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// ClaimTradeForSettlement 原子领取一笔成交进行提交：仅 pending/retry 可领取，
// 领取即置 submitting 并累加尝试次数。返回 false 表示已被处理/状态已推进。
func (db *DB) ClaimTradeForSettlement(tradeID string) (bool, error) {
	res, err := db.sql.Exec(
		`UPDATE trades SET settle_status = ?, settle_attempts = settle_attempts + 1
		 WHERE trade_id = ? AND settle_status IN (?, ?)`,
		SettleSubmitting, tradeID, SettlePending, SettleRetry,
	)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// RecoverSubmittingTrades 进程启动时把遗留的 submitting 重置为 pending：上一代
// 进程可能在广播后、记账前崩溃，该成交是否已落账由提交器在提交前的链上
// filled 对账判定，不在此处猜测。返回重置行数。
func (db *DB) RecoverSubmittingTrades() (int64, error) {
	res, err := db.sql.Exec(
		`UPDATE trades SET settle_status = ? WHERE settle_status = ? AND (tx_hash IS NULL OR tx_hash = '')`,
		SettlePending, SettleSubmitting,
	)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// MarkTradeSettled 标记成交已结算。txHash 为空表示落账由链上 filled 对账核实
// （提交 tx 在进程崩溃时丢失），note 记入 settle_error 以便审计区分。
func (db *DB) MarkTradeSettled(tradeID, txHash, note string) error {
	_, err := db.sql.Exec(
		`UPDATE trades SET settle_status = ?, tx_hash = CASE WHEN ? <> '' THEN ? ELSE tx_hash END, settle_error = ?
		 WHERE trade_id = ?`,
		SettleSettled, txHash, txHash, note, tradeID,
	)
	return err
}

// MarkTradeSettleRetry 标记瞬时失败、等待重试
func (db *DB) MarkTradeSettleRetry(tradeID, errStr string) error {
	_, err := db.sql.Exec(
		`UPDATE trades SET settle_status = ?, settle_error = ? WHERE trade_id = ?`,
		SettleRetry, errStr, tradeID,
	)
	return err
}

// MarkTradeSettleFailed 标记确定性失败终态（不再自动重试）。txHash 非空时
// 一并记录（如已广播但链上 revert 的交易）。
func (db *DB) MarkTradeSettleFailed(tradeID, errStr, txHash string) error {
	_, err := db.sql.Exec(
		`UPDATE trades SET settle_status = ?, settle_error = ?, tx_hash = CASE WHEN ? <> '' THEN ? ELSE tx_hash END
		 WHERE trade_id = ?`,
		SettleFailed, errStr, txHash, txHash, tradeID,
	)
	return err
}

// DeleteTradesBefore 删除指定时间之前的记录，用于保留期清理（默认两周）
// 优化：批量删除，避免长时间锁定
func (db *DB) DeleteTradesBefore(beforeUnix int64) (int64, error) {
	var totalDeleted int64
	batchSize := 1000 // 每批删除1000条
	
	for {
		res, err := db.sql.Exec(
			"DELETE FROM trades WHERE timestamp < ? AND rowid IN (SELECT rowid FROM trades WHERE timestamp < ? LIMIT ?)",
			beforeUnix, beforeUnix, batchSize,
		)
		if err != nil {
			return totalDeleted, err
		}
		deleted, err := res.RowsAffected()
		if err != nil {
			return totalDeleted, err
		}
		totalDeleted += deleted
		if deleted < int64(batchSize) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	return totalDeleted, nil
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