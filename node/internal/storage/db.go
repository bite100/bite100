package storage

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

const (
	tradesSchema = `
CREATE TABLE IF NOT EXISTS trades (
	trade_id TEXT PRIMARY KEY,
	pair TEXT NOT NULL,
	taker_order_id TEXT,
	maker_order_id TEXT,
	maker TEXT,
	taker TEXT,
	token_in TEXT,
	token_out TEXT,
	amount_in TEXT,
	amount_out TEXT,
	price TEXT NOT NULL,
	amount TEXT NOT NULL,
	fee TEXT,
	timestamp INTEGER NOT NULL,
	tx_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
CREATE INDEX IF NOT EXISTS idx_trades_pair ON trades(pair);
`

	orderbookSchema = `
CREATE TABLE IF NOT EXISTS orderbook_snapshots (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	pair TEXT NOT NULL,
	snapshot_at INTEGER NOT NULL,
	bids TEXT NOT NULL,
	asks TEXT NOT NULL,
	UNIQUE(pair, snapshot_at)
);
CREATE INDEX IF NOT EXISTS idx_orderbook_pair_snapshot ON orderbook_snapshots(pair, snapshot_at);
`

	ordersSchema = `
CREATE TABLE IF NOT EXISTS orders (
	order_id TEXT PRIMARY KEY,
	trader TEXT NOT NULL,
	pair TEXT NOT NULL,
	side TEXT NOT NULL,
	price TEXT NOT NULL,
	amount TEXT NOT NULL,
	filled TEXT NOT NULL DEFAULT '0',
	status TEXT NOT NULL,
	nonce INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	signature TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_pair ON orders(pair);
`
)

// DB 封装 SQLite 连接与表初始化
type DB struct {
	sql *sql.DB
}

// Open 打开或创建数据库，dataDir 下使用 storage.db
func Open(dataDir string) (*DB, error) {
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("mkdir data dir: %w", err)
	}
	path := filepath.Join(dataDir, "storage.db")
	sqlDB, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	if _, err := sqlDB.Exec("PRAGMA journal_mode=WAL"); err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("enable WAL: %w", err)
	}
	// 性能优化：设置SQLite优化参数
	optimizations := []string{
		"PRAGMA synchronous = NORMAL",      // 平衡性能和安全性
		"PRAGMA cache_size = -64000",       // 64MB缓存
		"PRAGMA temp_store = MEMORY",        // 临时表存储在内存
		"PRAGMA mmap_size = 268435456",     // 256MB内存映射
		"PRAGMA busy_timeout = 5000",       // 5秒忙等待
	}
	for _, opt := range optimizations {
		if _, err := sqlDB.Exec(opt); err != nil {
			sqlDB.Close()
			return nil, fmt.Errorf("optimization %s: %w", opt, err)
		}
	}
	if _, err := sqlDB.Exec(tradesSchema); err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("init trades: %w", err)
	}
	// 迁移：旧库无 maker 列时补结算字段
	if _, err := sqlDB.Exec("SELECT maker FROM trades LIMIT 0"); err != nil {
		for _, col := range []string{"maker TEXT", "taker TEXT", "token_in TEXT", "token_out TEXT", "amount_in TEXT", "amount_out TEXT"} {
			_, _ = sqlDB.Exec("ALTER TABLE trades ADD COLUMN " + col)
		}
	}
	if _, err := sqlDB.Exec(orderbookSchema); err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("init orderbook_snapshots: %w", err)
	}
	if _, err := sqlDB.Exec(ordersSchema); err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("init orders: %w", err)
	}
	return &DB{sql: sqlDB}, nil
}

// Close 关闭数据库连接
func (db *DB) Close() error {
	return db.sql.Close()
}
