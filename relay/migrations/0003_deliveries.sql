-- 比特100 订单公告栏中继：跨链交付登记表（第 63 轮桥-3，P1-③）
-- 一行 = 一笔跨链交付（幂等键与前端交付记录同构：<tradeId>:<receiver 小写>）。
-- 定位与 orders 表一致：中继只登记、不经手资金。登记的意义是把「同一笔交付
-- 同时只能被一个执行者认领」从单设备 localStorage 提升为跨设备仲裁——
-- 认领（claim）用条件 INSERT 原子占位（骑第 62 轮块 D 同款），汇报（report）
-- 必须带认领时的 attempt_id，旧尝试的迟到汇报不能覆盖新尝试。
-- account 为自报信息（中继无鉴权，与 pairs.creator 同口径）：只用于查询与限流，
-- 不构成身份背书；真正的防线是「同 delivery_id 同时只有一个未终局认领」。
CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id   TEXT NOT NULL,          -- <tradeId>:<receiver 小写>
  account       TEXT NOT NULL,          -- 发起方地址（小写，自报，仅登记/限流）
  state         TEXT NOT NULL,          -- claimed / initiated / delivered / anomaly / closed
  attempt_id    TEXT,                   -- 当前认领的尝试凭证 <delivery_id>#<n>
  channel       TEXT,                   -- layerzero / ccip / wormhole（可空）
  send_tx_hash  TEXT,                   -- 汇报回填：桥发送交易 hash
  tracking_id   TEXT,                   -- 汇报回填：通道追踪 ID（guid / messageId / txHash）
  note          TEXT,                   -- 汇报备注（异常原因 / 接管痕迹）
  created_at    INTEGER NOT NULL,       -- Unix 秒
  updated_at    INTEGER NOT NULL,       -- Unix 秒
  PRIMARY KEY (delivery_id)
);

CREATE INDEX IF NOT EXISTS idx_deliveries_account_updated ON deliveries (account, updated_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_state_updated ON deliveries (state, updated_at);
