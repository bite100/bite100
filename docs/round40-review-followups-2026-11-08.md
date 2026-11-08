# 第 40 轮：复审跟进批——第 38/39 轮复审跟进项一次清完（2026-11-08）

第 38 轮整批复审（拆分两半重派后均**有条件通过**）与第 39 轮复审
（**有条件通过**）共留下六组跟进项，主聊天逐条代码验真后合并成一批，
Ren 于 2026-11-08 拍板「和下一步一起推进」一次清完。本轮只动
`frontend/`、`indexer/`、`docs/`，零新增依赖，不碰 contracts/、
node/、relay/。

**与 3A 浸泡的隔离（重要）**：本轮**不重建 soak 包、不重启
bite100-soak 服务、不动 `frontend/scripts/soak/dist/`**。3A 窗口
（2026-11-08 13:41:43 → 11-15 13:41:43 JST）继续跑既有包；本轮对
dualread/runner 的源码修复只在下一次 soak 自然重建时生效，**3A 窗口
与结案口径不受影响**。`report.mjs` 本轮零改动，其 absorb 口径不变。

## 0. 本轮构成与门禁结果

| 门禁 | 结果 |
|---|---|
| 前端 `npm test` | **330/330 通过**（28 文件；基线 312 + 本轮新增 18） |
| 前端 `npm run build` | 通过（tsc -b + vite build） |
| indexer 全新 `npm ci` → `envio codegen` → `tsc --noEmit` | 退出码 0 |
| indexer `vitest` | **8 通过 / 2 跳过**（与基线一致） |
| 范围核对 | `git diff 7fbed7b..HEAD` 只含 `frontend/`、`indexer/`、`docs/`；soak dist 与 report.mjs 零改动 |
| runner.ts 编译核对 | 以与 soak build 相同的 esbuild 打包参数输出到 /tmp 验证通过（未产出到 dist） |

本轮提交（分支 `round40-review-followups`，自 main 7fbed7b 起）：

| 块 | 出处 | 内容 |
|---|---|---|
| 块 1+2 | 第 38 轮复审 F1/F2 | asIntString 数字分支安全整数化 + 边界参数化测试 |
| 块 3 | 第 38 轮复审 F3 | 节点适配器响应形态校验 requireBookSides（前端 + soak runner 共用） |
| 块 4 | 第 38 轮复审 F4 | droppedRows 口径写明「规范化阶段丢弃数」（仅注释） |
| 块 5 | Envio 复审跟进 | indexer viem 精确锁版 2.57.16 |
| 块 6 | 第 39 轮复审 F1 + 测试缺口 + F2 | tryNodes abort 短路、双挂死测试补双 signal 断言、FetchFn 契约注释 |

## 块 1+2 — asIntString 数字分支（第 38 轮复审 F1/F2）

**问题**：`frontend/src/services/dualread/adapters.ts` 的 `asIntString`
字符串路径很严格（"1.5" 判无效、全零小数才归一化），但数字分支是
`Number.isFinite(v)` 后 `Math.trunc(v).toString()`——数字 1.5 被静默
截断为 "1"，超出安全整数范围的数字带着已丢失的精度过关，与函数
注释「绝不静默截断」自相矛盾。现节点/中继都回字符串，该分支未被
真实数据触发，属潜伏缺陷。

**改法**：数字分支改用 `Number.isSafeInteger(v)`——满足才
`v.toString()`，否则返回 null（走既有丢弃路径）。字符串/BigInt 路径
一字未动；注释同步写明两路同口径及此前实现的矛盾点。

**测试**（块 2，`dualread.test.ts` 新增 10 条参数化用例，经公开入口
`toRawOrder` 验证，因 asIntString 未导出）：接受组——"-123.000" →
"-123"、"000123.000" → "000123"、" 123 "（trim）、
`Number.MAX_SAFE_INTEGER`、超安全整数的字符串形式原样保留；拒绝
组——"123."、"+123"、"1.5" 字符串、小数数字 1.5（与字符串同口径的
对照）、`MAX_SAFE_INTEGER + 1` 数字。

## 块 3 — 节点适配器响应形态校验（第 38 轮复审 F3）

**问题**：前端 `createNodeBookAdapter` 与 soak runner 的
`createDirectNodeAdapter` 都写 `data?.bids ?? []`——响应不是对象、
或 bids/asks 是非数组（如字符串/对象）时，要么被静默当成空盘口，
要么让非数组流进 `normalizeBookRows` 抛错位置不可控；中继适配器
早有 `Array.isArray` 校验，节点侧缺这一层。

**改法**：在 adapters.ts 新增共用校验 `requireBookSides(data,
sourceLabel)`——响应非对象 → 抛错；bids/asks 存在（非 undefined，
含 null）但不是数组 → 抛错；字段缺失 → 按空数组（正常空盘口）。
抛错走既有「源失败降级」路径，不伪装成零丢弃。前端节点适配器与
runner 服务端适配器**共用同一个函数**（runner 本就从 adapters 模块
导入 normalizeBookRows/sortBookSide），两侧同构靠共用实现保证，
不是靠两份相似代码。

**测试**：前端适配器补 4 条（bids 非数组抛错、asks 非数组抛错、
响应非对象抛错、字段缺失按空盘口且 rawRows/droppedRows 为 0）。
runner 侧没有 vitest 基建，未新建测试框架——其校验与前端共用同一
函数，前端测试即覆盖校验逻辑本身；runner 改动另以 esbuild 按 soak
build 同参数打包到 /tmp 验证可编译。

## 块 4 — droppedRows 口径写明（第 38 轮复审 F4）

`SourceBook.droppedRows` 只统计**规范化阶段**被 `toRawOrder` 判无效
的行，不含后续 digest 重构失败、验签失败、链上状态判无效的订单
——此前注释没写清这层范围，容易被误读为「全部无效订单数」。本块
只改注释：`types.ts` 的字段注释与 adapters.ts `normalizeBookRows`
的 docstring 都写明口径与不含范围。不改字段名、不新增指标、不动
计数逻辑。

## 块 5 — indexer viem 精确锁版（Envio 复审跟进）

**问题**：Envio 官方口径是云端重建会重新解析依赖、范围号会漂移
（envio 包本身已精确锁 3.15.0），而 `indexer/package.json` 的 viem
仍是 `^2.45.2`——lockfile 实际解析到 2.57.16 且线上部署验证通过，
但下一次云端重建可能解析到别的 2.x。

**改法**：`"viem": "^2.45.2"` → `"2.57.16"`（锁当前已验证版本，
不是升级）。`npm install` 同步 lockfile，diff 核对：lockfile 仅根
依赖规格 **1 行**变动（`node_modules/viem` 条目本就是 2.57.16），
envio 仍 3.15.0，无任何顺带升级。

**验证**：全新 `npm ci` → `envio codegen` → `tsc --noEmit` 退出码
0 → vitest 8 通过 / 2 跳过，与基线一致。注意此改动随下一次 main
推送由 Envio 自动部署，届时按既有运维口径轮换新端点（见
custom.envio 连接器文档），本轮不单独触发部署。

## 块 6 — 第 39 轮复审跟进（F1 + 测试缺口 + F2 契约注释）

**F1 — tryNodes abort 短路**：第 39 轮给 `nodeGet` 加了可选 signal，
但 `tryNodes` 捕获当次失败后不看信号状态、继续遍历剩余节点——靠
已取消信号让后续 fetch 立即失败兜底，语义没错但多走空转，且与
nodeGet 注释「整源立即判失败」不严格一致（现配置为单节点，影响
近零，属实现与注释对齐问题）。
改法：`tryNodes` 增加可选参数 `{ signal }`（nodeGet 透传），catch
中若 `signal.aborted` 立即抛当前错误短路；无信号时行为与此前完全
一致。nodeGet 注释同步改成与实现严格一致的表述。
测试：nodeClient.test.ts 新增 4 条——信号已取消时请求函数只调用
一次、途中取消在当次失败后短路、信号未取消时正常回退不误伤、
nodeGet 层透传 signal 且只发一次请求（既有三节点 mock 配置）。

**测试缺口 — 双挂死断言**：第 39 轮「两源皆永不返回」测试只断言
结果 unavailable，未断言两个源的 signal 都被真取消。本轮改造该
测试，分别捕获两侧 fetcher 收到的 signal 并断言
`aborted === true`（与两个单源挂死测试同口径）。

**F2 — FetchFn 契约注释**：`fetchIndexerTrades` 的直调路径靠内部
AbortController + signal 取消，对「不遵守 AbortSignal 的注入
FetchFn」没有竞速兜底。第 39 轮复审建议补竞速或明确契约；本轮
按「不重复造轮子」裁定**不加第二层竞速**（竞速只在
`loadDualTrades` 的 `callWithTimeout` 一层），改为在
`tradesDual.ts` 的 `FetchFn` 类型上补契约注释：注入实现必须遵守
init.signal、取消后尽快 reject。只加注释，不改逻辑；生产默认
fetch 本就遵守 signal，不受影响。

## 骑乘对照表（集成优先核对）

| 本轮新件 | 骑乘的既有件 / 平台能力 |
|---|---|
| asIntString 数字分支修复 | 平台标准 `Number.isSafeInteger`；判无效走第 38 轮既有丢弃计数路径 |
| requireBookSides 形态校验 | 新增共用小函数一份，前端适配器与 soak runner 两处共用（不写两份）；抛错走既有源失败降级 |
| droppedRows 口径 | 纯注释，对齐 types.ts 与 adapters.ts 既有文档口径，不新增指标 |
| viem 锁版 | npm 依赖锁定机制本身；锁的版本就是 lockfile 已解析、线上已验证的 2.57.16 |
| tryNodes abort 短路 | 平台标准 `AbortSignal.aborted`；复用第 39 轮 nodeGet 已透传的 signal 通道 |
| FetchFn 契约注释 | 复用第 39 轮 `callWithTimeout` 的竞速分工，不叠第二层超时机制 |

## 范围与后续

- 本轮零新增依赖；`git diff 7fbed7b..HEAD` 只含 `frontend/`、
  `indexer/`、`docs/`。association.ts 的解码类型断言收紧按此前
  裁定继续暂缓（非阻断、有测试覆盖，churn 风险大于收益）。
- soak 相关：仅 runner.ts 源码一行校验接入（共用函数），**未重建
  包、未重启服务**；3A 窗口（2026-11-08 13:41:43 → 11-15
  13:41:43 JST）与结案口径不受影响，源码修复在下一次自然重建时
  生效。
- 本轮已验收、已合并并推送（main f6a8123，2026-11-08）。
