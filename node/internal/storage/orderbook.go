package storage

import (
	"database/sql"
	"encoding/json"
)

// OrderbookLevel [price, quantity]
type OrderbookLevel [2]string

// OrderbookSnapshot 订单簿快照（为 Phase 3 预留）
type OrderbookSnapshot struct {
	Pair       string          `json:"pair"`
	SnapshotAt int64           `json:"snapshotAt"`
	Bids       []OrderbookLevel `json:"bids"`
	Asks       []OrderbookLevel `json:"asks"`
}

// InsertSnapshot 插入订单簿快照
func (db *DB) InsertSnapshot(s *OrderbookSnapshot) error {
	bids, err := json.Marshal(s.Bids)
	if err != nil {
		return err
	}
	asks, err := json.Marshal(s.Asks)
	if err != nil {
		return err
	}
	_, err = db.sql.Exec(
		`INSERT OR REPLACE INTO orderbook_snapshots (pair, snapshot_at, bids, asks)
		 VALUES (?, ?, ?, ?)`,
		s.Pair, s.SnapshotAt, string(bids), string(asks),
	)
	return err
}

// GetLatestSnapshot 获取某交易对最新快照
func (db *DB) GetLatestSnapshot(pair string) (*OrderbookSnapshot, error) {
	var snapshot OrderbookSnapshot
	var bidsStr, asksStr string
	err := db.sql.QueryRow(
		`SELECT pair, snapshot_at, bids, asks FROM orderbook_snapshots
		 WHERE pair = ? ORDER BY snapshot_at DESC LIMIT 1`,
		pair,
	).Scan(&snapshot.Pair, &snapshot.SnapshotAt, &bidsStr, &asksStr)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(bidsStr), &snapshot.Bids); err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(asksStr), &snapshot.Asks); err != nil {
		return nil, err
	}
	return &snapshot, nil
}

// ListSnapshots 按时间范围查询某交易对快照
func (db *DB) ListSnapshots(pair string, since, until int64, limit int) ([]*OrderbookSnapshot, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := db.sql.Query(
		`SELECT pair, snapshot_at, bids, asks FROM orderbook_snapshots
		 WHERE pair = ? AND snapshot_at >= ? AND snapshot_at <= ?
		 ORDER BY snapshot_at ASC LIMIT ?`,
		pair, since, until, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*OrderbookSnapshot
	for rows.Next() {
		var s OrderbookSnapshot
		var bidsStr, asksStr string
		if err := rows.Scan(&s.Pair, &s.SnapshotAt, &bidsStr, &asksStr); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(bidsStr), &s.Bids); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(asksStr), &s.Asks); err != nil {
			return nil, err
		}
		out = append(out, &s)
	}
	return out, rows.Err()
}

// DeleteSnapshotsBefore 删除指定时间之前的快照，用于保留期清理（默认两周）
// 优化：批量删除，避免长时间锁定
func (db *DB) DeleteSnapshotsBefore(beforeUnix int64) (int64, error) {
	var totalDeleted int64
	batchSize := 1000 // 每批删除1000条
	
	for {
		res, err := db.sql.Exec(
			"DELETE FROM orderbook_snapshots WHERE snapshot_at < ? AND rowid IN (SELECT rowid FROM orderbook_snapshots WHERE snapshot_at < ? LIMIT ?)",
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
