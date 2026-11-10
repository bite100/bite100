-- Bit100 MCP 自助注册（第 59 轮块 3，方案 1 主路线）。
-- agents 增列：注册来源与时间（首 24 小时爬坡按 created_at 判定）、
-- 展示名、预留的钱包身份绑定列（SIWE/ERC-8004 只预留结构：本轮
-- 只存不验、不据此授权，见 round59 文档）。
-- registration_events：注册端点的防滥用计数（按 IP + 全局，滚动 1 小时）。
ALTER TABLE agents ADD COLUMN name TEXT;
ALTER TABLE agents ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE agents ADD COLUMN wallet_address TEXT;
CREATE TABLE IF NOT EXISTS registration_events (
  ip TEXT NOT NULL,
  ts_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_registration_events_ts ON registration_events (ts_ms);
CREATE INDEX IF NOT EXISTS idx_registration_events_ip_ts ON registration_events (ip, ts_ms);
-- 注册开关：置 '0' 即暂停自助注册（不用重部署）；缺省开放。
INSERT OR IGNORE INTO config (key, value) VALUES ('registration_open', '1');
