# 第 39 轮：成交双源健壮性四项修复（2026-11-08）

Envio 接线增量复审（范围 1f2731f..de00da3）结论**有条件通过**：工作流
一行注入本身正确、部署侧经主聊天补验无误（密钥已设、Pages 恰一次运行
成功、线上 bundle 实测含索引器端点），但运行时双源取数有四个缺口，
ChatGPT 提出、主聊天逐条 grep 验真全部属实。Ren 于 2026-11-08 拍板
开小修复轮四项一起修。本轮只动 `frontend/` 与 `docs/`，零新增依赖，
不碰 contracts/、node/、relay/、indexer/ 与 soak 脚本，不改任何
`VITE_` 变量与工作流。

## 0. 本轮构成与门禁结果

| 门禁 | 结果 |
|---|---|
| 前端 `npm test` | **312/312 通过**（28 文件；基线 303 + 本轮新增 9） |
| 前端 `npm run build` | 通过（tsc -b + vite build） |
| 零 diff 核对 | `git diff de00da3..HEAD -- contracts/ node/ relay/ indexer/` 为空（0 行） |

本轮提交（分支 `round39-dual-source-hardening`，自 main de00da3 起）：

| 块 | 内容 |
|---|---|
| 块 1 | 双源取数超时真取消 + GraphQL errors 检查（tradesDual / nodeClient / RecentTradesWidget 守卫） |
| 块 2 | 索引器查询服务端排序补 logIndex 次级键（tradesDual） |
| 块 3 | 桌面「成交记录」页签接入双源（TradeTabsPanel + 共用归一化） |
| 块 4 | 新增测试 9 条 + 本文档 + INDEX 同步 |

## 块 1 — 双源取数超时（真取消）+ GraphQL errors 检查

**缺口**：第 35 轮 D6 用 `Promise.allSettled` 隔离两源失败，但它只能
隔离「报错返回」，隔离不了「永不返回」——任一源的请求挂死时
allSettled 永不落定，健康源已取到的数据也被拖住不展示；且
`fetchIndexerTrades` 与节点 `fetch` 都没有传任何取消信号。另外
GraphQL 在 HTTP 200 下仍可带 `errors`（执行/部分失败），旧代码不查
该字段、会把错误响应当成「成功查到 0 笔」，来源标注可能误报。

**改法**（`frontend/src/services/tradesDual.ts`）：

- 新增命名常量 `NODE_TRADES_TIMEOUT_MS = 5000`、
  `INDEXER_TRADES_TIMEOUT_MS = 8000`，与内部 `callWithTimeout()`：
  以平台标准 `AbortController` 在超时时真 abort 底层 fetch（连接
  随之释放），同时以竞速兜底保证即使对端 promise 不理会 signal 也
  准时判失败。`loadDualTrades` 两源各走一层，超时值可经第 4 参注入
  （测试用小值，不真等）；超时按该源失败降级，D6 语义不变：单源
  超时另一源照常出结果，双源都超时才整体不可用。
- `fetchIndexerTrades` 新增末位可选 `options { signal, timeoutMs }`：
  双源路径由 `loadDualTrades` 传入统一 signal；直接调用时自建
  AbortController 按 8 秒兜底。signal 真传进 fetch 的 init。
  解析 JSON 后若 `errors` 为非空数组 → 抛错走既有降级路径；
  `data` 缺失/非数组时的既有兜底保留不变。
- `frontend/src/nodeClient.ts` 的 `nodeGet` 新增可选第 3 参
  `options { signal }`：传入时 fetch 带信号（信号 abort 后后续节点
  尝试立即失败，即整源判失败，符合超时语义）；不传时与此前行为
  完全一致，其他调用方零影响。`nodePost` 未动。
- `RecentTradesWidget` 的双源 fetcher 改为接收并透传 signal；
  5 秒轮询加 in-flight 守卫（effect 内局部标记）：上一轮未完成时
  跳过本轮 tick，卸载清理逻辑不变。

**超时取值理由**：节点在本机/隧道近端、响应通常亚秒级，5 秒足够
判活、又不至于让故障态多拖；索引器是跨公网 GraphQL 且有冷查询，
宽放至 8 秒避免误杀慢查询。两者都显著小于页签 15 秒轮询周期，
单轮取数不会跨周期堆积。

## 块 2 — 服务端排序补次级键

`TRADES_QUERY` 的 `order_by: { blockTimestamp: desc }` 改为
`order_by: [{ blockTimestamp: desc }, { logIndex: desc }]`
（Hasura 多字段排序语法；`logIndex` 字段名与查询选择集、Envio
schema 及客户端 merge 的 (timestamp, logIndex) 排序口径一致，已
核对）。同块多笔成交时，服务端 limit/offset 分页边界从此确定，
不再依赖未定义次序。

## 块 3 — 桌面「成交记录」页签接入双源

**缺口**：第 34 轮成交双源只接了右栏「最新成交」
（RecentTradesWidget），桌面底部「成交记录」页签
（TradeTabsPanel）仍是节点单源——同一份成交数据两个入口口径不一。

**改法**（`frontend/src/components/dashboard/TradeTabsPanel.tsx`）：
配置 `VITE_INDEXER_URL` 时，成交 fetch 改走 `loadDualTrades`
（与「最新成交」同一条路径：超时、合并 `(chainId, txHash, logIndex)`
口径、失败降级全共用），**没有另写任何 GraphQL 或合并逻辑**；
未配置时仍为节点单源、行为不变。节点行归一化抽为
`tradesDual.normalizeNodeTradeRow()` 共用（「最新成交」一并改用），
防两处映射口径漂移。页签内 `/api/orders` 的订单 fetch 未动。

**展示与错误语义**：页签现有形态与列（时间 / 价格 / 数量 / 结算）
不变，两种数据源经统一行视图模型收敛到同一张表。错误语义对齐
双源：单源失败降级展示，双源皆失败才置错误态；来源标注沿用站内
既有口径——页首来源说明行与「最新成交」同文案，「结算」列双源下
以「待索引 / 已上链」标注来源（单源下维持「已上链 / 待结算」）。

**用户看到的变化（一句话）**：桌面端「成交记录」页签现在和「最新
成交」一样以链上索引为准对账——节点漏记的成交也会出现、节点独有
的成交会标「待索引」，且单个数据源卡住时页面不再跟着卡死。

## 块 4 — 测试（新增 9 条，tradesDual.test.ts）

- 索引器 fetcher 永不 resolve + 节点正常 → 注入 50ms 超时后仍返回
  节点数据，并断言索引器侧 signal 已真 abort；
- 节点 fetcher 永不 resolve + 索引器正常 → 对称断言；
- 两源皆永不返回 → 超时后 unavailable，不无限等待；
- `fetchIndexerTrades` 收到 HTTP 200 + `{ errors: [...] }` → 抛错；
  `errors: []` → 不抛错、正常返回；
- AbortSignal 真传进 fetch init；直接调用时内部超时到点 abort
  底层请求并判失败（注入 30ms）；
- `TRADES_QUERY` 排序断言（块 2）；`normalizeNodeTradeRow` 字段
  兜底与 `TradeID` 别名断言（块 3）。

## 骑乘对照表（集成优先核对）

| 本轮新件 | 骑乘的既有件 / 平台能力 |
|---|---|
| 双源取数超时 | 平台标准 `AbortController` / `AbortSignal`（零新依赖）；失败语义复用第 35 轮 D6 的 `loadDualTrades` 降级口径 |
| 节点侧 signal 透传 | 既有 `nodeClient.nodeGet` / `tryNodes` 多节点尝试机制，仅加可选参数 |
| GraphQL errors 检查 | 既有 `fetchIndexerTrades` 解析路径 + 既有失败降级通道 |
| 服务端次级排序 | Hasura 多字段 `order_by` 语法（Envio 现有 GraphQL 层能力） |
| 页签双源 | 既有 `loadDualTrades` / `mergeTradeSources` / `fetchIndexerTrades` 全套，未新写查询或合并 |
| 节点行归一化共用 | 由 RecentTradesWidget 既有内联映射抽出为 `normalizeNodeTradeRow`，两处共用 |

## 范围与后续

- 本轮为纯前端健壮性修复，不改变双源合并口径、方向证明口径或
  3A 计数口径；3A 窗口（2026-11-08 13:41:43 → 11-15 13:41:43 JST）
  使用的 soak 包不含本轮改动、不受影响。
- 双源故障隔离自本轮起才算闭环（复审原话的认定条件：超时隔离
  确认后方可认定）。后续 ChatGPT 复审照常在主聊天合并推送后进行。
