-- Bit100 MCP 公开入口（Workers 形态）的 D1 结构（第 57 轮）。
-- 对应第 49 轮 stdio 版的三个后端：agents 注册表 JSON → agents 表；
-- WriteGuard 内存计数 → usage_daily + rate_events；审计 JSONL → audit_log。
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('maker', 'taker', 'operator')),
  per_order_max_quote TEXT NOT NULL,
  daily_max_quote TEXT NOT NULL,
  write_rate_per_minute INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_daily (
  agent_id TEXT NOT NULL,
  day TEXT NOT NULL,
  total_quote REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, day)
);
CREATE TABLE IF NOT EXISTS rate_events (
  agent_id TEXT NOT NULL,
  ts_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_events_agent_ts ON rate_events (agent_id, ts_ms);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  params_json TEXT NOT NULL,
  result TEXT NOT NULL,
  tx_hash TEXT,
  error_code TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_agent_ts ON audit_log (agent_id, ts);
INSERT OR IGNORE INTO config (key, value) VALUES ('kill_switch', '0');
