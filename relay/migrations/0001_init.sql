-- 比特100 订单公告栏中继：订单表（第 30 轮，腿 A）
-- 一行 = 一张已验签的签名订单。digest（EIP-712 摘要，按链域计算）是天然主键：
-- 同一订单重复投递必然同 digest，去重即 INSERT OR IGNORE。
CREATE TABLE IF NOT EXISTS orders (
  digest         TEXT PRIMARY KEY,          -- 0x + 64 hex，EIP-712 order digest
  chain_id       INTEGER NOT NULL,          -- 11155111 = Sepolia / 84532 = Base Sepolia
  order_id       TEXT NOT NULL,             -- 订单消息内的 orderId（前端生成）
  user_address   TEXT NOT NULL,             -- 签名者地址（小写存储）
  pair           TEXT NOT NULL,             -- 如 BTC/USDT
  side           TEXT NOT NULL,             -- buy | sell（未签名消息字段）
  price          TEXT NOT NULL,             -- wei 整数字符串（与节点 POST /api/order 同形状）
  amount         TEXT NOT NULL,             -- wei 整数字符串（amountIn）
  amount_out     TEXT NOT NULL,             -- 按规范公式 amountIn*price/1e18 派生（验签重建值）
  token_in       TEXT NOT NULL,             -- 交易对 Token0（base）
  token_out      TEXT NOT NULL,             -- 交易对 Token1（quote）
  filled         TEXT NOT NULL DEFAULT '0',
  status         TEXT NOT NULL DEFAULT 'open',  -- open | partial | filled | cancelled（消息字段，中继不裁决）
  nonce          INTEGER NOT NULL,          -- 签名者的链上结算 nonce（签名覆盖）
  created_at     INTEGER NOT NULL,          -- Unix 秒（= 签名内 timestamp）
  expires_at     INTEGER NOT NULL,          -- Unix 秒（签名覆盖；查询侧按此下架）
  exec_type      TEXT,                      -- ''/limit/market（未签名执行指令，可空）
  signature      TEXT NOT NULL,             -- 0x 65 字节签名
  raw_json       TEXT NOT NULL,             -- 投递原文 JSON（便签可移植：换中继重发同一份）
  nostr_event_id TEXT,                      -- Nostr 镜像成功后回填的事件 id（失败为空）
  received_at    INTEGER NOT NULL           -- 中继收到时间（Unix 秒）
);

-- 按 (链, 交易对) 拉订单簿、按 (链, 地址) 查「我的订单」是两条主查询路径
CREATE INDEX IF NOT EXISTS idx_orders_chain_pair ON orders (chain_id, pair, expires_at);
CREATE INDEX IF NOT EXISTS idx_orders_chain_user ON orders (chain_id, user_address, expires_at);
CREATE INDEX IF NOT EXISTS idx_orders_expires ON orders (expires_at);
CREATE INDEX IF NOT EXISTS idx_orders_chain_orderid ON orders (chain_id, order_id);
