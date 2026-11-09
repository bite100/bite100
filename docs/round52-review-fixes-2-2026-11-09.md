# 第 52 轮：双半审查条件项修复批（2026-11-09）

> 状态：分支 `round52-review-fixes-2` 本地提交（基线 main `b8c5c8e`），未推送、未合并、未部署；合约零改动、零新依赖。
> 来源：第 50 轮与第 51 轮合并推送（`b8c5c8e`）后的 ChatGPT 双半审查——第 50 轮半「有条件通过」5×P2、第 51 轮半「有条件通过」2×P1＋3×P2；主聊天逐条对合并后代码裁定后合并成批（9 项），Ren 拍板「先做完本批，再跑 Sepolia 补测」。
> 其中第 50 轮半第 5 项（hardCancel 的 missing revert data 证据强度）经主聊天裁定**在本合约语境下不成立**（cancelledOrders 是自动 getter、存在时不可能 revert；且 never-locked 另需锁读为空共同把关），本轮不改、不在本批内。

## 1. A 组：第 51 轮审查项（frontend）

### A1（P1）中继簿适配器交易对隔离

- **裁定**：适配器 `fetchBook` 不校验行 pair；下游 `mergeBooks` 不按 pair 筛候选；验签代币对又从行自称 pair 经 `getPairTokens` 推导——跨交易对订单可自洽验真后混入请求对的可成交集。下游预飞行模拟大概率拦下实际结算，但单源信任边界确有洞。
- **改法**：`createRelayBookAdapter.fetchBook` 组簿时逐行校验 `row.pair === 请求 pair`，不符丢弃并单独计数（`frontend/src/services/dualread/adapters.ts:228-247`）；`SourceBook` 新增可观测计数 `pairMismatchRows`（`frontend/src/services/dualread/types.ts:67`），与规范化丢弃 `droppedRows` 语义分开（前者是「行不属于这个交易对」，后者是「行本身残缺」）。
- **测试**：dualread.test.ts 新增 2 条——混入两条他对行被丢弃且 `pairMismatchRows=2`、本对行保留、`droppedRows=0` 不混计；全部本对行时计数为 0、簿面不受影响。

### A2（P1）缺省 fetch 超时未覆盖响应体

- **裁定**：第 51 轮补的 10 秒超时在响应头到达后即被 `finally` 清除，`fetchBook` 随后 `await res.json()` 在计时之外——「头到、体永不到」仍无限等待，是第 45 轮挂死根因的变体。
- **改法**：同一 `AbortController` 的 timer 只在 `json()` 落定（完成或失败）后才清理；头阶段失败由 catch 清理（`frontend/src/services/dualread/adapters.ts:191-215`）。`json()` 从未被调用的路径（调用方见 `!ok` 先抛错）下 timer 在 timeoutMs 到点自熄，对已完成响应 abort 无副作用，上界仍在。
- **测试**：dualread.test.ts 新增 2 条——响应头立即返回但 `json()` 只在收到 abort 时才 reject → `fetchBook` 在截止期内 reject；头与体都正常时计时不影响读取。第 51 轮「对端永不响应」测试保留且继续通过。

### A3（P2）成交索引诚实性

- **裁定**：(a) `fetchIndexerTrades` 对「无 data 且无 errors」的响应以 `[]` 兜底，上层会当成「查到 0 笔成交」展示成暂无成交——实打实的展示 bug；(b) 索引滞后无检测/无标注。按 Ren 口径（索引只是展示缓存），滞后只标注、绝不阻断。
- **改法**：(a) `data.Trade` 缺失或非数组 → 抛错 `indexer graphql response missing data.Trade`，走既有 failed 口径（`frontend/src/services/tradesDual.ts:401` 附近）；`data.Trade` 为空数组仍是真空。(b) 新增 `fetchIndexerChainProgress`（`tradesDual.ts:211`）骑同一条 fetch 路径查 `_meta`（列表形态，按 chainId 挑行，字段取实测的 progressBlock/sourceBlock/isReady），`loadIndexerTrades` 并行查询并在 outcome 新增 `stale`（`tradesDual.ts:282-284`）：`!isReady` 或滞后 `sourceBlock − progressBlock > 50` 块（阈值常量 `INDEXER_STALE_LAG_BLOCKS = 50`，`tradesDual.ts:186`）即标 stale；进度查询失败 = 判不出 → stale=false，不拿不确定当滞后喊。**stale 不并入 failed、不阻断数据返回。** 不引入第二套 GraphQL 客户端。
- **页内呈现（功能变更带说明）**：`TradeTabsPanel` 成交页签接入 `tradesStale`（`frontend/src/components/dashboard/TradeTabsPanel.tsx:92,284,292`）——滞后时来源行显示「来源：链上索引（Envio）；索引同步中，最新成交可能尚未显示」，空表时显示「暂无成交（索引同步中，显示可能不完整）」；其余消费者（OrderBookSection/RecentTradesWidget/usePairStats/useTradesOHLC）只读 trades/failed，新增字段对它们无影响。
- **测试**：tradesDual.test.ts 新增 7 条——无 data 无 errors 抛错、data 在但 Trade 缺失抛错、经 loadIndexerTrades 异常响应 failed=true、落后 >50 块 stale=true、isReady=false stale=true、双链 _meta 列表按 chainId 挑行且已追平 stale=false、进度查询失败 stale=false 且成交照常返回。

### A4（P2）链上撤单弹窗入口文案

- **裁定**：结果页文案已诚实，但弹窗执行前说明笼统承诺「立即释放＋永久作废」，对从未落锁的订单不成立。
- **改法**：执行前说明补一段例外（`frontend/src/components/HardCancelAction.tsx:93`）：若该单尚未在链上落锁，则没有可释放的余额、也无法提前作废，本次操作只会确认它未落锁，它仍留在订单簿里、过期前仍可能被落锁成交，只能等到期自动失效。结果页文案不动。

### A5（P2）撮合须区分数据源故障与无对手盘

- **裁定**：`runBookRound` 的降级口径是「该面为空＋errors 记录」不抛错，`executeFrontendMatch` 旧实现只看可成交集——中继/RPC 故障、链上快照缺失/过旧都会被误报成「暂无可成交订单」。
- **改法**：拿到 round 后先查错误面（`frontend/src/services/matching/execute.ts:120-131`）：`round.errors.relay || round.errors.rpc || !round.chainOk` → 返回既有 `aborted` 状态（整单未提交、订单留簿，与既有失败口径同型）＋新文案常量 `SOURCE_UNAVAILABLE_MSG`（`execute.ts:64`：「订单簿或链上状态暂不可用，本次未撮合；订单已留簿，请稍后重试。」）；`runBookRound` 本身抛错（非降级路径的意外）同样按数据源不可用返回，不再落 no-match。簿与链都干净时空集仍走 no-match 原文案。
- **测试**：matching.test.ts 新增 4 条——中继拉取失败、链上快照读取失败、快照过旧（chainOk=false）三向 aborted＋不可用文案；干净空簿仍 no-match 且文案逐字不变。

## 2. B 组：第 50 轮审查项（frontend/scripts/stage4 运行器）

### B1（P2）迟到成交回执事件对账

- **裁定**：`reconcileAfterTimeout` 对 status=1 回执 `parseTradeEvents` 后直接计数认回；解析为空也照样认回（0 腿计数），且不与事件扫描发现对账——RPC 两读不一致时仍可能报 complete。
- **改法**：扫描侧同步按 tx 留存每笔事件参数（maker/taker/amountIn/amountOut，`engine.ts:1636` 起）；回执侧认回条件改为（`engine.ts:1685` 起的新分支）：解析事件**非空**，且其多重集经 `tradeEventsCover`（`engine.ts:1262`）**覆盖扫描发现**（逐笔计数比对，地址大小写不敏感）。不满足 → 与回执取不到/status≠1 同路：`late-tx-unverified` 留痕＋进 unverifiedLate → `incomplete-unverified-late-tx` 抛错保隔离、不计数。
- **对账程度如实说明**：回执解析本已保证事件只来自目标 Settlement 合约（`parseTradeEvents` 的地址过滤，第 45 轮 B2-lite）；扫描（getLogs 全量流）与回执（单 tx 完整日志）是同一批链上事件的两种读法，多重集覆盖即证明两读一致。回执里多出的同 tx 他方事件（批量结算混入）不影响覆盖判定，也不计入本运行器账目（legs 计数仍以回执解析的本合约事件全量为准，与第 50 轮前口径一致）。
- **测试**：faults 新增 F5（status=1 但 logs 为空 → 保隔离不计数）、F6（回执事件金额与扫描发现不符 → 保隔离不计数）；F3（两读一致 → 认回 complete）继续通过。

### B2（P2）恢复账本 fsync 持久化序

- **裁定**：`writeFileSync → renameSync` 只保证进程崩溃级的原子替换，不等于掉电持久化（缺文件与目录 fsync）。
- **改法**：新增 `writeFileAtomicDurable`（`engine.ts:404`）：写 `.tmp` → fsync 文件 → rename → fsync 父目录，`persistPending` 改走此序（`engine.ts:693`）。fsync 在个别平台/文件系统不支持（尤其目录 fsync）时降级跳过该步、不拦写入，代码注释与 README 均注明保证以 fsync 语义为限。saveState 是可重建的汇总快照，不在本项面内，维持原写法。
- **测试**：faults 新增 F8——经新序落盘后主文件存在、无 `.tmp` 残留、新账本实例读回条目完整（fsync 本身在进程内不可观测，钉的是落盘布局与内容完整性；掉电保证来自 fsync 语义而非本测试）。

### B3（P2）恢复账本语义校验

- **裁定**：第 50 轮全字段校验只是类型/存在校验（legs 可负/可小数、chainId 可非整数、pair/takerDigest 无格式约束）。
- **改法**：`validatePendingRows` 在类型校验同处补语义（`engine.ts:536` 起）：txHash 与 takerDigest 须 `0x`+64 位 hex；chainId 须整数且 ∈ `CHAINS`（运行器测试网白名单，与既有链门禁同集合）；pair 须 ∈ `TRADE_PAIRS`（运行器轮转集合）；legs 须整数且 ≥1（创建点 `probeSettlement` 的 `legs = attempt.legsKept`，已提交结算恒 ≥1）；takerAmountIn 非 null 时须十进制整数字符串；notedAt 须正数。每条都与创建点实际取值对齐，不误杀自产条目；不合仍走 `PendingLedgerCorruptError` 失败关闭，错误文案更新为「缺失、类型不符或值不合法」。校验继续手写（与第 50 轮裁定一致，不引入 schema 库）。
- **测试**：faults 新增 F7——12 个语义不合法用例（主网 chainId、非整数 chainId、legs 0/负/小数、txHash 短串、takerDigest 非 hex、未知 pair、takerAmountIn 小数/空串、notedAt 0/负）逐项抛 `PendingLedgerCorruptError`；对照 Base Sepolia（84532）合法条目放行。

### B4（文档）运行约束写明

- stage4 README 新增「运行约束（第 52 轮 B4 写明）」：**单写者**——同一 `S4_DIR` 同时只允许一个运行器进程；落盘判重只保证串行重启幂等，不保证双进程并发（并行须各自独立 `S4_DIR`）。**持久化保证范围**——pending 账本：进程崩溃恒保、掉电/系统崩溃以 fsync 语义为限（平台不支持时降级尽力而为）；metrics/state 不在本保证内。同文件另加第 52 轮条目登记 B1–B3 口径变更。

## 3. 测试对账

| 门禁 | 基线（main `b8c5c8e`） | 本轮 |
|---|---|---|
| 前端 vitest | 411 全绿 | **426 全绿**（+15：A1×2、A2×2、A3×7、A5×4；A4 为纯文案无新测） |
| `npm run build` | 过 | 过 |
| `npx tsc -b`（src 工程） | 过 | 过（0 错） |
| stage4 bundle（build.mjs） | 过 | 过 |
| stage4 触碰文件类型自检 | 基线 ad-hoc tsc 有 14 个既有错误（import.meta.env 类型与 node 源桩，与本轮无关） | 错误集与基线**逐字一致**，零新增 |
| faults.test.mjs 默认组 | 9 项过（F1a–F4，F4-slow 跳过） | **13 项过**（+F5/F6/F7/F8），F4-slow 仍默认跳过 |
| faults.test.mjs 全量组（`S4_FAULTS_INCLUDE_SLOW=1`） | 10 项过 | **14 项过**（含 F4-slow 等满 120s 宽限变体） |

提交：`be5dc27`（A 组代码＋测试）、`94e692d`（B 组代码＋faults＋README）、本笔（轮次文档＋INDEX）。

## 4. 骑乘对照表（每个新件骑哪个既有件）

| 本轮新件 | 骑乘的既有件 |
|---|---|
| A1 pair 过滤与计数 | 既有适配器组簿路径与 `SourceBook` 加法字段模式（rawRows/droppedRows 先例）；零新抽象 |
| A2 响应体超时 | 平台 `AbortController`/`AbortSignal` 既有纪律（第 51 轮块 3 同一控制器延寿，不换实现） |
| A3a 缺失 data 抛错 | 既有 GraphQL errors 口径（第 39 轮）与 `loadIndexerTrades` 的 failed 语义 |
| A3b 滞后标注 | Envio 官方 `_meta` 进度字段（progressBlock/sourceBlock/isReady）＋既有 tradesDual fetch 路径与超时层；零新客户端 |
| A4 文案 | 既有弹窗结构与结果页诚实文案口径（只补执行前说明） |
| A5 源故障区分 | `runBookRound` 既有 `errors`/`chainOk` 错误面＋既有 `aborted` 状态与留簿口径（不新增状态机） |
| B1 事件对账 | 既有 `parseTradeEvents`（含 Settlement 地址过滤）与扫描侧同一 `settleIface` 解析；多重集比对为纯函数小件 |
| B2 fsync 序 | Node `node:fs` 同步 API（openSync/writeFileSync/fsyncSync/renameSync），骑第 50 轮 tmp+rename 布局 |
| B3 语义校验 | 运行器既有常量 `CHAINS`、产品配置 `TRADE_PAIRS`、第 50 轮手写校验风格（不引进 schema 库，与第 50 轮裁定一致） |
| B4/文档 | 既有 stage4 README 结构与本 INDEX 登记格式 |

**零新依赖**（package.json 未动）；合约 `contracts/` 零改动；relay/indexer/mcp 零改动。

## 5. 未尽事项（如实）

1. 本轮只做本地分支，未 push/未 merge/未部署——按仓库纪律等主聊天复验与 Ren 点头；合并后按例送 ChatGPT 复审，并轮换 Envio 端点（本轮未动 indexer 配置，端点轮换只因新提交例行执行）。
2. Sepolia 补测不在本轮面内：本批落地后，用合并后的最终前端＋本轮修复的运行器跑（Ren 已定序）。
3. soak 遗留工具的 `ShadowObserver` import 断裂（第 51 轮登记）本轮未动，维持登记状态。
4. A3 的滞后阈值 50 块为本轮定值（双链出块节奏不同，Sepolia 约 10 分钟、Base 约 100 秒）：若补测/日常观察发现误报或漏报，再按实测调整，属展示参数非安全线。
