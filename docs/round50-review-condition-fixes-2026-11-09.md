# 第 50 轮：审查条件项统一修复轮（2026-11-09）

> 状态：分支 `round50-review-condition-fixes`（基于 main `3db8f89`）
> 本地提交，未推送，待主聊天复核。
> 裁定来源：第 48 轮推送后 ChatGPT 双半审查的 6 个条件项（主聊天
> 已逐条对着代码核实为真）；Ren 2026-11-09 14:12 拍板「先放着，
> 等第 49 轮做完再统一修」，第 49 轮完成后本轮即那次统一修复。
> **零合约改动，零部署**；变更面仅限 `frontend/scripts/stage4/`、
> `frontend/src/services/hardCancel*` 与 docs/。

## 1. 背景（一句话版）

第 48 轮把验收运行器的三处 P1 修好并推送，推送后复审却在修复
本身里又挖出 2 个 P1 + 2 个 P2（裁判的失败关闭还有边角没关严），
外加 hardCancel 一处错误分类与 48 轮文档头部状态未回填。裁判要
判 Sepolia 补测，自己的账先得对严——本轮一次修完 6 项，并按
复审建议补齐四个故障注入场景的自动化验证。

## 2. 逐项修复

### ①隔离对账放行未验真的迟到成交（engine.ts `reconcileAfterTimeout`）

旧实现：事件扫描发现的迟到成交若回执在宽限内取不到（或
status≠1），只记一行 `late-tx-unverified` 就 continue，函数最后
照报 `result: 'complete'`，调用方据此删除隔离——一笔从未入账、
只能靠事件扫描发现、且扫描当时回执不可见的迟到成交，就被「对
完账」放行、再无人复查（本机 RPC 多后端读滞后是实测过的常态，
这个时序完全可能发生）。

修法：迟到成交分两路记账——验真成功的照旧计数并记
`late-settlement-recovered`（`lateRecovered` 只计验真笔数）；
未验真的收集起来，对账结尾先落 `incomplete-unverified-late-tx`
留痕行，再**抛普通错误**（非零容忍 trip）：调用方既有口径正是
「对账抛错 → 保隔离、本轮不对本链提新单、下一周期重试」，回执
届时可见即认回，持续不可见则隔离持续保留（失败关闭）。范围
不动：自家已 `notePending` 的结算走 ① 段 `confirmPendingEntry`，
回执不可见本就 trip 停机，语义未变。

### ②恢复账本首次创建崩溃窗（engine.ts `loadPending`）

旧实现：`persistPending` 写 `.tmp` 后 rename，但 `loadPending`
在主文件缺失时直接返回空账本、不看 `.tmp`——进程若被 SIGKILL
卡在**首次** tmp 写入与 rename 之间，第一笔已记账结算凭空丢失。

修法：主文件缺失时改读遗留 `.tmp`：经全字段 schema 校验（见
④）合法才采用，并 rename 愈合文件布局（愈合失败不拦恢复——
数据已在内存，下一次落盘仍会重写主文件）；校验不过抛
`PendingLedgerCorruptError` 失败关闭。主文件已存在时口径不变。

### ③跨进程幂等只查内存（engine.ts `Stage4Ledger.hasProbeRecord` 新增）

旧实现：`recoverPendingSettlements` 的「已确认」判重只查内存
`ledger.settlements`。确认顺序是「先写 probe 记录行、再清
pending」（第 48 轮 P2），进程恰好死在两者之间时，重启后内存
是空的——同一笔会被重新链上确认并向 metrics JSONL 再追加一行
probe，下游按行汇总即双计。

修法：新增 `hasProbeRecord(txHash)`——扫 metrics JSONL 查该
txHash 的既有 probe 记录行（落盘事实）；恢复路径与隔离对账 ①
段的判重都改为「内存 settlements + 落盘 probe 记录」双查，命中
即走 already-confirmed 口径：只清 pending，不再确认、不再追加
probe 行、不重复计数。metrics 不存在或个别行是坏 JSON（半写
行）按无记录跳过——判重只防重复，读不通不能反过来堵死恢复
（账本损坏的失败关闭判定在 loadPending，不在这里）。

### ④loadPending 校验过浅 + 同哈希异内容静默覆盖（engine.ts）

旧实现：只验数组性、txHash 为 string、chainId 为 number；合并
时 `Map.set` 后写覆盖先写。

修法：新增 `validatePendingRows` 全字段校验——txHash（非空
string）、chainId（number）、pair（string）、takerDigest
（string）、legs（number）、takerAmountIn（string 或 null）、
notedAt（number）逐一验类型/存在，任一不符指明行号与字段抛
`PendingLedgerCorruptError`。合并改为：同 txHash 先与既有条目
逐字段比对（`samePendingContent`），内容相同才合并一条；内容
冲突抛 `PendingLedgerCorruptError`，禁止静默覆盖。

### ⑤hardCancel 裸 CALL_EXCEPTION 误分类（services/hardCancel.ts）

旧实现：`isMethodMissingError` 把裸 `code === 'CALL_EXCEPTION'`
直接判为「方法不存在」。但 CALL_EXCEPTION 是 ethers v6 对
eth_call 失败的通用错误码——方法存在但合约真 revert（带业务
原因）同样是它；真 revert 被误降级成 never-locked，会绕过第
48 轮刚加的 unknown「状态待确认」保护。

修法：删掉裸 code 判断，只保留能证明 selector 缺失的消息类
证据——`missing revert data`（旧栈无此方法时 ethers 的实际
报错，data=null）、`function selector was not recognized`、
`method not found`。裸 CALL_EXCEPTION（哪怕伴随 execution
reverted 业务原因）一律归读失败 → unknown 路径：宁可待确认，
不误下「从未落锁」结论。补反例测试两例：分类器单测（裸
CALL_EXCEPTION + 业务 revert 原因 → false；只有裸 code → false；
真没读口的 missing revert data → 仍为 true）与端到端一例
（cancelledOrders 真 revert → 结果 unknown、reason 指明读取
失败、不发交易）。

### ⑥第 48 轮文档头部状态回填

`docs/round48-runner-fix-2026-11-09.md` 头部由「未推送，待主
聊天复核」改为已推送事实（main `3db8f89`、双半审查结论：骑乘
半有条件通过/运行器半不通过、6 条件项指向本轮修复），并注明
正文个别表述以第 50 轮收紧后的实现为准；INDEX 第四十八轮条目
状态列同步回填。本运行器 README 补第 50 轮口径段（对账不放行、
.tmp 兜底、全字段校验、落盘判重、故障自检跑法）。

## 3. 故障注入补测（ChatGPT 建议四场景，全部自动化）

新增 `frontend/scripts/stage4/faults.test.mjs`（+ 只做再导出的
`faults.entry.ts`），骑 soak 自检的既有路子（仓库 esbuild 打包
entry → Node 里以结构假件驱动真实 engine 代码；假 provider/
假 settlementRead，不连真链、不读密钥）。跑法：
`cd frontend && node scripts/stage4/faults.test.mjs`。

| 场景 | 对应检查 | 结果 |
|---|---|---|
| ① 首次 notePending 写入中途被杀（.tmp 遗留）后重启恢复 | F1a–F1c（.tmp 采用/愈合、.tmp 损坏失败关闭、缺字段拦截）+ F1f（.tmp 遗留 → 恢复确认 + 清账全程） | 全过 |
| ② 交易卡 mempool 后迟到上链、隔离对账须捕获 | F3（事件扫描认回、计数、报 complete 且 lateRecovered=1） | 过 |
| ③ 对账时回执暂时不可见 → 隔离保留 | F4（回执 status=0：抛错、无 complete 行、不计数）+ F4-slow（回执始终取不到 null：等满生产宽限 120s 后同样抛错保隔离） | 全过（F4-slow 实测总时长 122s；与 F4 同一 `!receipt \|\| status!== 1` 分支，因须等满真实宽限，默认跳过、`S4_FAULTS_INCLUDE_SLOW=1` 启用） |
| ④ probe 行写完、pending 未清时被杀 → 重启不重复记账 | F2（重启后零链上确认调用、probe 行仍恰好 1 行、计数不重复、pending 清除、落 `already-confirmed` 行） | 过 |
| 附：同哈希条目合并/冲突（④项校验） | F1d（异内容冲突 → 抛错）、F1e（同内容 → 合并一条） | 全过 |

## 4. 骑乘对照表（三条常设规矩①②的交付核对）

| 本轮新/改组件 | 骑乘的既有件 |
|---|---|
| 故障注入自检的打包/驱动骨架 | soak `timing.test.mjs` 的既有模式（esbuild 打 entry + Node 断言）与 stage4 `build.mjs` 的同一套打包参数（define/banner），零新工具 |
| 测试里的 TradeSettled 日志构造 | 生产 `SETTLEMENT_ABI` + ethers `Interface.encodeEventLog`，不手拼 topic/data |
| 账本全字段校验 | 项目无直接依赖的 schema 库（zod 仅为传递性 peer、从未被引用）；沿用 Stage4Ledger 内第 48 轮既有手写校验口径扩展，不为 7 个字段引新依赖 |
| 跨进程判重的落盘数据源 | 既有 metrics JSONL 的 probe 记录行（第 45/48 轮既有落盘格式），不新增状态文件 |
| 对账失败关闭的承接 | 调用方既有「reconcile 抛错 → 保隔离」口径（第 48 轮），不新造状态机 |
| hardCancel 分类收紧 | 既有三态结构（value/method-missing/read-failed）与 unknown 呈现，只改分类证据集 |

新增依赖：**无**。新写代码只在胶水与本项目差异化语义（账本
时序、隔离对账口径、分类证据集），无通用轮子重造。

## 5. 验证证据（本轮实测）

- 前端全量：`npx vitest run` → **39 文件 / 452 例全过**（基线
450，本轮新增 2 例：hardCancel 第 50 轮分类器单测 + 真 revert
端到端反例；hardCancel 文件单跑 17/17）。
- `npm run build` → 通过。
- 运行器：`node scripts/stage4/build.mjs` → bundle 构建通过；
engine.ts + main.ts + faults.entry.ts 以 ad-hoc tsc 参数
（`--types node,vite/client` 等，与第 48 轮同法）类型检查零
错误。
- 故障注入：`node scripts/stage4/faults.test.mjs` 默认组 9 项
全过；`S4_FAULTS_INCLUDE_SLOW=1` 全量 10 项全过（含 120s
宽限变体，总时长 122s）。
- 合约/中继/索引器/MCP：零改动（`git diff` 自查：变更文件仅限
`frontend/scripts/stage4/**`、`frontend/src/services/hardCancel*`
与 docs/；diff 密钥扫描无命中）。

## 6. 未做项登记（明确不在本轮）

- Sepolia 补测（用修好的运行器当裁判，含第 47 轮登记的链上
边界补测）→ 下一步单独执行，不在本轮。
- 隔离对账的迟到成交目前仍以计数 + 对账行方式认回、不构造
SettlementRecord（第 48 轮已知边界），本轮只堵「未验真放行」，
不扩口径。
- `src/utils.ts` 的错误格式化里另有一处 CALL_EXCEPTION 字样
匹配（错误文案呈现，非方法缺失分类），不在本轮工单范围，
未动。
