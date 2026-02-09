package storage

import (
	"database/sql"
	"strconv"
	"time"
)

// OrderExpired 判断订单是否已过期（用于 Replay/过期防护）
func OrderExpired(o *Order) bool {
	if o == nil || o.ExpiresAt <= 0 {
		return false
	}
	return time.Now().Unix() > o.ExpiresAt
}

// Order 订单（与 Phase3 设计文档 §2.2 对齐）
type Order struct {
	OrderID   string `json:"orderId"`
	Trader    string `json:"trader"`
	Pair      string `json:"pair"`
	Side      string `json:"side"` // buy | sell
	Price     string `json:"price"`
	Amount    string `json:"amount"`
	Filled    string `json:"filled"`
	Status    string `json:"status"` // open | partial | filled | cancelled
	Nonce     int64  `json:"nonce"`
	CreatedAt int64  `json:"createdAt"`
	ExpiresAt int64  `json:"expiresAt"`
	Signature string `json:"signature,omitempty"`
}

// InsertOrder 插入或替换订单（新订单或状态更新）
func (db *DB) InsertOrder(o *Order) error {
	filled := o.Filled
	if filled == "" {
		filled = "0"
	}
	_, err := db.sql.Exec(
		`INSERT OR REPLACE INTO orders (order_id, trader, pair, side, price, amount, filled, status, nonce, created_at, expires_at, signature)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		o.OrderID, o.Trader, o.Pair, o.Side, o.Price, o.Amount, filled, o.Status, o.Nonce, o.CreatedAt, o.ExpiresAt, o.Signature,
	)
	return err
}

// UpdateOrderStatus 更新订单状态（如撤单后设为 cancelled）
func (db *DB) UpdateOrderStatus(orderID, status, filled string) error {
	_, err := db.sql.Exec(
		`UPDATE orders SET status = ?, filled = ? WHERE order_id = ?`,
		status, filled, orderID,
	)
	return err
}

// GetOrder 按 orderId 查询
func (db *DB) GetOrder(orderID string) (*Order, error) {
	var o Order
	var filled, sig sql.NullString
	err := db.sql.QueryRow(
		`SELECT order_id, trader, pair, side, price, amount, filled, status, nonce, created_at, expires_at, signature
		 FROM orders WHERE order_id = ?`,
		orderID,
	).Scan(&o.OrderID, &o.Trader, &o.Pair, &o.Side, &o.Price, &o.Amount, &filled, &o.Status, &o.Nonce, &o.CreatedAt, &o.ExpiresAt, &sig)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	o.Filled = filled.String
	o.Signature = sig.String
	return &o, nil
}

// ListOrdersOpenByPair 查询某交易对当前盘口（open/partial），买盘价格降序、卖盘价格升序，用于订单簿展示
func (db *DB) ListOrdersOpenByPair(pair string, limit int) (bids, asks []*Order, err error) {
	if limit <= 0 {
		limit = 200
	}
	query := `SELECT order_id, trader, pair, side, price, amount, filled, status, nonce, created_at, expires_at, signature
		  FROM orders WHERE pair = ? AND status IN ('open', 'partial') ORDER BY created_at ASC`
	rows, err := db.sql.Query(query, pair)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var filled, sig sql.NullString
	for rows.Next() {
		var o Order
		if err := rows.Scan(&o.OrderID, &o.Trader, &o.Pair, &o.Side, &o.Price, &o.Amount, &filled, &o.Status, &o.Nonce, &o.CreatedAt, &o.ExpiresAt, &sig); err != nil {
			return nil, nil, err
		}
		o.Filled = filled.String
		o.Signature = sig.String
		if o.Side == "buy" {
			bids = append(bids, &o)
		} else {
			asks = append(asks, &o)
		}
		if len(bids)+len(asks) >= limit*2 {
			break
		}
	}
	// 买盘价格降序、时间升序；卖盘价格升序、时间升序（Price-Time）
	sortOrdersBids(bids)
	sortOrdersAsks(asks)
	if len(bids) > limit {
		bids = bids[:limit]
	}
	if len(asks) > limit {
		asks = asks[:limit]
	}
	return bids, asks, rows.Err()
}

func priceFloat(s string) float64 {
	f, _ := strconv.ParseFloat(s, 64)
	return f
}

func sortOrdersBids(bids []*Order) {
	if len(bids) <= 1 {
		return
	}
	// 价格降序，同价时间升序
	for i := 0; i < len(bids); i++ {
		for j := i + 1; j < len(bids); j++ {
			pi, pj := priceFloat(bids[i].Price), priceFloat(bids[j].Price)
			if pi < pj || (pi == pj && bids[i].CreatedAt > bids[j].CreatedAt) {
				bids[i], bids[j] = bids[j], bids[i]
			}
		}
	}
}

func sortOrdersAsks(asks []*Order) {
	if len(asks) <= 1 {
		return
	}
	for i := 0; i < len(asks); i++ {
		for j := i + 1; j < len(asks); j++ {
			pi, pj := priceFloat(asks[i].Price), priceFloat(asks[j].Price)
			if pi > pj || (pi == pj && asks[i].CreatedAt > asks[j].CreatedAt) {
				asks[i], asks[j] = asks[j], asks[i]
			}
		}
	}
}

// ListOrdersByTrader 按交易对与交易者查询订单（用于「我的订单」）
func (db *DB) ListOrdersByTrader(trader, pair string, limit int) ([]*Order, error) {
	if limit <= 0 {
		limit = 100
	}
	query := `SELECT order_id, trader, pair, side, price, amount, filled, status, nonce, created_at, expires_at, signature
		  FROM orders WHERE 1=1`
	args := []interface{}{}
	if trader != "" {
		query += ` AND trader = ?`
		args = append(args, trader)
	}
	if pair != "" {
		query += ` AND pair = ?`
		args = append(args, pair)
	}
	query += ` ORDER BY created_at DESC LIMIT ?`
	args = append(args, limit)
	rows, err := db.sql.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Order
	var filled, sig sql.NullString
	for rows.Next() {
		var o Order
		if err := rows.Scan(&o.OrderID, &o.Trader, &o.Pair, &o.Side, &o.Price, &o.Amount, &filled, &o.Status, &o.Nonce, &o.CreatedAt, &o.ExpiresAt, &sig); err != nil {
			return nil, err
		}
		o.Filled = filled.String
		o.Signature = sig.String
		out = append(out, &o)
	}
	return out, rows.Err()
}

// ListOrders 按时间范围查询订单（用于保留期内数据）
func (db *DB) ListOrders(pair string, since, until int64, limit int) ([]*Order, error) {
	if limit <= 0 {
		limit = 500
	}
	query := `SELECT order_id, trader, pair, side, price, amount, filled, status, nonce, created_at, expires_at, signature
		  FROM orders WHERE created_at >= ? AND created_at <= ?`
	args := []interface{}{since, until}
	if pair != "" {
		query += ` AND pair = ?`
		args = append(args, pair)
	}
	query += ` ORDER BY created_at ASC LIMIT ?`
	args = append(args, limit)
	rows, err := db.sql.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Order
	for rows.Next() {
		var o Order
		var filled, sig sql.NullString
		if err := rows.Scan(&o.OrderID, &o.Trader, &o.Pair, &o.Side, &o.Price, &o.Amount, &filled, &o.Status, &o.Nonce, &o.CreatedAt, &o.ExpiresAt, &sig); err != nil {
			return nil, err
		}
		o.Filled = filled.String
		o.Signature = sig.String
		out = append(out, &o)
	}
	return out, rows.Err()
}

// DeleteOrdersBefore 删除指定时间之前的订单，用于保留期清理（默认两周）
func (db *DB) DeleteOrdersBefore(beforeUnix int64) (int64, error) {
	res, err := db.sql.Exec("DELETE FROM orders WHERE created_at < ?", beforeUnix)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// OrdersWithinRetention 按保留月数裁剪时间范围（与 TradesWithinRetention 一致）
func OrdersWithinRetention(since, until, now int64, retentionMonths int) (effectiveSince, effectiveUntil int64) {
	return TradesWithinRetention(since, until, now, retentionMonths)
}
