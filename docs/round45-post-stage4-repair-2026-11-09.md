# 第四十五轮：阶段 4 后修复轮（2026-11-09）

阶段 4 通宵验收（2026-11-08 夜至 11-09 晨，Ren 09:03 拍板「按 C
收尾，阶段 4 记部分通过」）与 631035e 推送后 ChatGPT 复审留下的
待修项在本轮收口：复审 A1（P1）/A2/A3（P2）/B4/B5（P2）、阶段 4
运行中先行以未提交形态打的 B1/B3/B2-lite 与方案 B 超时硬化正式
入仓、Sepolia 周期卡点隔离埋点。**零合约改动**（forge 未动），
改动面只有 `frontend/src`（下单路径）与 `frontend/scripts/stage4`
（验收运行器）。分支 `round45-post-stage4-repair`，基点 main
631035e，本地提交待复核推送。

## 块 1：运行器加固收尾（scripts/stage4）

四个提交：

| 提交 | 内容 |
|---|---|
| cd5768c | 原样纳入未提交的 engine.ts 改动：B1 索引器探针分页（offset 每页 50、最多 10 页，消除「只读最近 50 条」假 indexerMismatch）、B3 probePresence 读簿异常记 probe-inconclusive 不再冒泡、B2-lite 回执事件解析先核对 log.address==Settlement；方案 B 超时硬化（单链周期 420s 硬超时、索引器复查 240s、中继发单 30s/节点拉簿 10s）。来源即阶段 4 分段 9–11 的实测运行版本 |
| 6b56ceb | 卡点隔离埋点 + 中继拉簿 30s 超时包裹（见下） |
| 8d5ad6c | B4 失败关闭 + 索引器探针新口径（见下） |
| d3c7ab8 | B5 待确认结算恢复账本（见下） |

### 卡点隔离埋点：下轮如何读出卡点

阶段 4 的卡死形态：Sepolia 每个周期 2 起卡在一个无超时的网络
等待上（进程 CPU 0.1% 干等一条经 VM 代理的连接），但具体调用
从未隔离到行。本轮给周期路径的每个网络调用加命名计时
（`traceCall`，engine.ts）：调用**前**先同步落一行
`call-start`（appendFileSync 同步写盘——进程随后永久挂死这行
也已在 metrics 里），结束落 `call-end`（耗时 + 成败 + 错误摘要）。

调用名清单：`gen.generateBatch`、`relay.postOrder`、`book.node`、
`book.relay`、`chain.snapshot`、`match.execute`、`dualread.round`、
`rpc.getTransactionReceipt`、`rpc.orderFilledIn`、`rpc.orderLocks`、
`indexer.fetchTrades`、`tx.lockForOrder`、`tx.releaseOrderLock`、
`tx.releaseExpiredOrderLock`、`tx.settleTrade`、`tx.settleTradeStatic`、
`tx.chargeFailedSettlement`。

**读法**：运行中或挂死后看 `stage4-metrics.jsonl` 尾部——最后一个
只有 `call-start`、没有配对 `call-end` 的 `call` 名就是卡住的
调用；若 `match.execute` 有 start 无 end 而其内部的
`book.*`/`chain.snapshot` 都已配对，则卡点在撮合执行内部（预检/
模拟/提交段），可再按该粒度继续分。

超时补齐审计（逐项核对后的结论）：中继发单 30s（方案 B 已补）、
节点拉簿 10s（已补）、索引器取数 8s（tradesDual 既有
`INDEXER_TRADES_TIMEOUT_MS`，第 39 轮）、viem http 传输默认 10s
（chainState 骑乘）——**唯一全程无界的外发请求是产品
`createRelayBookAdapter` 的裸 `fetch`**（无 signal、无超时），与
阶段 4「经代理的连接干等」形态吻合，是卡点头号嫌疑。本轮按
简报边界只动 scripts/stage4：在 `buildChainCtx` 给中继适配器
包裹一层 30s 硬超时 + 打点（超时按拉簿失败走既有降级：双读记
源错误、在场探针记无结论）。产品侧根治见文末「超范围发现 1」；
卡点最终定性以下轮埋点实测数据为准，本轮不下结论。

### B4 失败关闭（政策口径）

Ren 2026-11-09 09:13 定版口径（原话要旨）：「我们只是中介，
交易都在链上，有问题可以去链上查」——**索引器只是展示缓存、
不是账本，正确性以链上为准**。据此把探针政策拆成两半：

- **结算状态未知 → 失败关闭（零容忍同级）**：`probeSettlement`
  的回执读取改宽限轮询（120s / 5s 间隔，RPC 瞬时报错不下结论、
  继续轮询到宽限届满）；宽限内拿不到回执、或 taker 已成交量
  读数重试 3 次仍失败 → `trip('invalidSettle', …)` 停机保全
  证据（退出码 3）。旧口径下这类异常会降级成普通 cycle-error
  带着未知状态继续跑，本轮堵死。
- **索引器探针 → 只记观察项，不停机**：查询失败记
  `probe-inconclusive`（source=indexer）；超宽限未收录记一次性
  `lagging` 并保持 pending 继续复查；收录后字段多重集不符记
  `mismatch-observed`（fail 行 + probe-indexer 行留痕）。三者都
  不再 trip `indexerMismatch`（该计数仅为状态结构历史兼容保留，
  不再递增）。阶段 4 两次 trip 实测均为 Envio 免费层收录滞后
  18–30+ 分钟、最终 39/39 全部收录且字段全对，正是本口径的依据。

### B5 恢复账本

已提交但未探针确认的结算落盘 `S4_DIR/stage4-pending-settlements.json`
（tmp+rename 原子写，骑 saveState 同款写法）：`probeSettlement`
拿到 txHash 的第一时间先 `notePending`，全部链上核对通过后
`confirmPending` 清除。运行器启动时先
`recoverPendingSettlements`：按与探针完全相同的链上口径（回执
status=1、成交事件数 == 腿数、taker 已成交量不超签名量）逐笔
复查遗留条目，确认的并入本轮 settlements/计数并落 `recovery`
行；任一笔状态未知/不符按 B4 失败关闭停机（退出码 3），确认
完才进新周期。阶段 4 期间真实发生过 VM 重启杀进程（分段 10），
本账本堵的是「进程死在提交后、确认前 → 该笔结算从记账消失」。

## 块 2：A1 下单双通道竞速 + 超时（frontend/src）

提交 b57c2f3。

**A1**：`broadcastOrderDualChannel`（orderService.ts）旧实现
`Promise.all` 等双通道都落定才返回——任一通道挂死（无超时
连接）即无限拖住下单。改为竞速语义：

- 任一通道**先接单即返回成功**；同
...[truncated 2086 chars]