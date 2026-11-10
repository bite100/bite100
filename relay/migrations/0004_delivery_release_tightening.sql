-- 比特100 中继：交付登记占位释放收紧（第 63 轮审查修复批，P1-2）
-- 背景：0003 的口径是 anomaly/closed 行无条件释放占位——但 anomaly 里混着
-- 「桥发送已广播、结果未知」的行，无条件释放等于给第二台设备开双发窗口。
-- 本迁移只加两列，不动 0003 已应用的结构：
--   last_reconcile   前端 report 上来的链上对账结论（found / missing /
--                    unknown）：anomaly 行只有带 missing 结论才许再 claim；
--                    无结论或 found/unknown 的 anomaly 行保持占用。
--   broadcast_evidence  该行是否已有广播证据（发送 hash / 追踪 ID / 预取 ID
--                    任一回填，或 report 显式标记）1 = 有：supersede 接管
--                    claimed/initiated 行时要求零广播证据，任一非空永不接管。
ALTER TABLE deliveries ADD COLUMN last_reconcile TEXT;
ALTER TABLE deliveries ADD COLUMN broadcast_evidence INTEGER NOT NULL DEFAULT 0;
