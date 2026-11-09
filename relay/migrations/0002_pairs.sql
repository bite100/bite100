-- 比特100 订单公告栏中继：自助上架交易对注册表（第 60 轮）
-- 一行 = 一个用户自助上架的交易对。pair_key 是地址型键：
--   <chainId>:<base 地址小写>/<quote 地址小写>
-- 种子 8 对（符号键 BTC/USDT 等）不入本表，继续走 src/config.ts 内置代币表。
-- 元数据（symbol/name/decimals）由中继在注册时经链上复读写入，提交方自报不算数；
-- creator 仅为自报信息（中继无鉴权），只用于基础限流与留痕，不构成任何背书。
CREATE TABLE IF NOT EXISTS pairs (
  chain_id       INTEGER NOT NULL,          -- 11155111 = Sepolia / 84532 = Base Sepolia
  pair_key       TEXT NOT NULL,             -- 地址型键 <chainId>:<base>/<quote>（地址小写）
  base_token     TEXT NOT NULL,             -- base 代币合约地址（小写）
  quote_token    TEXT NOT NULL,             -- quote 代币合约地址（小写）
  base_symbol    TEXT NOT NULL,             -- 链上复读的 symbol
  quote_symbol   TEXT NOT NULL,
  base_name      TEXT NOT NULL,             -- 链上复读的 name
  quote_name     TEXT NOT NULL,
  base_decimals  INTEGER NOT NULL,          -- 链上复读的 decimals
  quote_decimals INTEGER NOT NULL,
  creator        TEXT,                      -- 上架者自报地址（可空，仅信息/限流用）
  created_at     INTEGER NOT NULL,          -- Unix 秒
  PRIMARY KEY (chain_id, pair_key)
);

CREATE INDEX IF NOT EXISTS idx_pairs_chain_created ON pairs (chain_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pairs_chain_creator ON pairs (chain_id, creator, created_at);
