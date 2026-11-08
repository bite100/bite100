# 第 38 轮：适配器 amount 解析修复 + 压测口径统一（2026-11-08）

第 37 轮增量复审判**不通过**，其中节点源零贡献（前 14 个评估轮次
orders 142 / common 0 / nodeOnly 0 / relayOnly 142）是 3A 证据成立的
硬卡点。主聊天按复审给的只读五步法完成根因调查（报告：
`~/workspace/bite100-soak/notes/node-source-investigation-2026-11-08.md`），
**实证锁定在「适配器字段形态」层**：节点 `/api/orderbook` 返回的订单行
里，`amount` 是定点小数字符串（如 `"1000000000000000.000000000000000000"`，
撮合引擎内部 `big.Float.Text('f', 18)` 回写的产物；`price` 保持纯整数
串），而 dualread 的 `toRawOrder()`/`asIntString()` 只接受 `/^-?\d+$/`
纯整数串 → 节点每一行都被判无效、被调用方 `.filter()` 静默丢弃且无
任何计数。对照组：中继返回的 amount 是纯整数串，故 relay 142 全活、
节点全灭。节点数据本身完整（直查原始簿与 SQLite 均在：Sepolia soak
单 24 张含 9 笔成交、Base 15 张全 open）——**缺陷在测量链，不在被测
系统**。

同轮裁定带上：第 37 轮复审项 4「部分关闭」的运行时口径问题——
runner 的 `discoveryStats()` 不排除篡改单，与收官工具 report.mjs 和
§6.3「有效订单」定义不一致，且 soak README 对此的表述与代码相反。

**Ren 于 2026-11-08 13:27 拍板：修适配器 + 换包重启 3A 计时。** 本轮
只做代码与文档（分支 `round38-adapter-fix`，自 main c9765d6 拉）；
换包、改压测的节点地址指向（主聊天决定改走本机 127.0.0.1:8080/8081，
传输层调整、与本轮代码无关）与重启 bite100-soak 由主聊天在本轮合并
推送后执行，3A 新窗口起止时刻回填第 34 轮文档 §6.3 占位。
**主聊天回填（2026-11-08）**：换包重启已执行——bite100-soak 于
2026-11-08 13:41:43 JST 以第 38 轮新包重启，节点地址已改为本机
127.0.0.1:8080/8081；新 3A 窗口 **2026-11-08 13:41:43 JST →
2026-11-15 13:41:43 JST**；第一窗口数据归档为
`~/workspace/bite100-soak/soak-metrics.window1-aborted-20261108.jsonl`。

**范围红线**：`contracts/`、`node/`、`relay/` 零 diff（已用
`git diff c9765d6..HEAD -- contracts/ node/ relay/` 验空，0 行）；
零新依赖；未重启任何服务；未触碰主工作树的 soak dist。

## 0. 本轮构成与门禁结果

| 门禁 | 结果 |
|---|---|
| 前端 `npm test` | **303/303 通过**（28 文件；基线 299 + 本轮新增 4，均为块 1/2 双读回归） |
| 前端 `npm run build` | 通过（tsc -b + vite build） |
| soak 构建 | `node scripts/soak/build.mjs` 在本 worktree 产出 dist/soak.mjs 成功（仅验证可打包，未部署） |
| soak 计时自检 | `npm run test:soak-timing` 全部通过 |
| soak 汇总自检 | `npm run test:soak-report` 全部通过 |
| ABI 漂移检查 + 自检 | 主检 9 条声明一致、自检全过——在本 worktree 无 forge 产物，改于主工作树核验（其 contracts 树与本轮零 diff、同版产物）；检查脚本与 ABI 声明本轮零改动 |
| 零 diff 核对 | `git diff c9765d6..HEAD -- contracts/ node/ relay/` 为空（0 行） |

本轮提交（分支 `round38-adapter-fix`，自 main c9765d6 起）：

| 块 | 提交 |
|---|---|
| 块 1+2（前端侧）适配器解析 + 计数基建 | `ff5beff` |
| 块 2（soak 侧）+块 3 runner 接入与口径统一 | `60f9edd` |
| 块 4 文档同步（README / §6.3 / INDEX） | `7987380` |
| 本文档 | 本提交 |

## 块 1 — adapters.ts：定点小数解析（根因修复）

`frontend/src/services/dualread/adapters.ts` 的 `asIntString` 在原有
纯整数串/number/bigint 三路之外，新增一路：匹配
`/^(-?\d+)\.(\d+)$/` 的定点小数字符串，**小数部分全为零时归一化为
整数部分**；小数部分含任何非零数字 → 返回 null（该行走既有判无效
丢弃路径），绝不静默截断。走同一解析函数的字段一并受益/不受损：

- `amount`：节点形态 `"1000000000000000.000000000000000000"` →
  `"1000000000000000"`（根因字段，修复）；
- `filled`：节点数据库中同样已是定点小数串，一并受益；
- `price`：节点保持纯整数串、原路径不变，不受损；
- 中继行：amount 本为纯整数串，原路径不变。

同提交修正 adapters.ts 中 `toRawOrder` 的注释：原文声称「调用方计数
丢弃，不静默吞」，与代码事实不符（两个调用方都只 filter、无计数）
——改为指向块 2 落地的真实机制（`normalizeBookRows` 计数 →
`SourceBook.droppedRows`）。

## 块 2 — 丢弃计数：normalizeBookRows + SourceBook + soak round 字段

- **计数基建（adapters.ts）**：新增导出 `normalizeBookRows(rows)`，
  返回 `{ orders, droppedRows }`。前端节点适配器、前端中继适配器、
  soak 服务端节点适配器三个取数点统一改走它（此前各自
  `.map(toRawOrder).filter(...)`）。核对结论：soak runner 的
  `createDirectNodeAdapter` 与前端**共用同一 `toRawOrder`**（runner
  只自带取数外壳），故解析修复与计数一处落地、两处生效。
- **类型（types.ts）**：`SourceBook` 加两个可选加法字段 `rawRows`、
  `droppedRows`（本次拉取 bids+asks 的原始行数与被丢弃行数）；旧
  记录与未计数的消费方缺省 undefined，向后兼容。
- **soak 接入（runner.ts）**：`RoundRecord` 新增 `nodeRawRows`、
  `nodeDroppedRows` 两字段，由本轮 `round.books` 的节点源书籍按
  交易对聚合写入 JSONL round 行——只做加法字段，旧 round 行无此
  两字段，report.mjs 等既有消费方不受影响。此后「整源被字段形态
  吞掉」在每轮落盘数据里直接可见（rawRows>0 且 droppedRows=rawRows
  即全吞报警形态）。
- **前端正式双读的 metrics 暴露面**：现行 ShadowMetrics 无现成的
  原始/丢弃行位置，本轮**不新造指标面**，只做到 SourceBook 层
  （数据已在 books 里，未来要进指标时从此处取）；如实注明，不冒充
  已接入。

## 块 3 — runner 口径统一：discoveryStats 排除篡改单

`SoakLedger.discoveryStats()` 的 eligible 循环新增 `if (sub.tampered)
continue`，与 report.mjs 的 `absorb()`（篡改单单独计数后 return）和
第 34 轮文档 §6.3「有效订单」定义（未被标记篡改）三方对齐。此后
JSONL 每轮 `discovery` 字段与收官汇总同口定义，实时发现率不再含
篡改单（第 37 轮复审项 4 由「部分关闭」收口）。

## 块 4 — 文档同步

- `frontend/scripts/soak/README.md`：① 处错误表述（原称「篡改单不
  由 runner 的 discoveryStats 计入 eligible」——与旧代码相反）改
  为与新代码一致的说法（自第 38 轮起 runner 与 report.mjs 口径
  一致、均排除篡改单，并注明此前 runner 未排除这一事实）；round
  记录字段说明补 `nodeRawRows`/`nodeDroppedRows`。
- `docs/round34-nodeless-stage2-2026-11-08.md` §6.3：补记第一个
  3A 正式窗口（2026-11-08 12:12 JST 起）因测量链缺陷**中止**、
  样本不计入 3A（仅作 shakedown 记录）；新窗口自换包重启时刻起
  7 天，**起止时刻留占位，由主聊天重启时回填**。
- `docs/INDEX.md`：加第 38 轮行。

## 骑乘对照（集成优先：每个改动骑乘哪个既有件）

| 本轮改动 | 骑乘的既有件 |
|---|---|
| asIntString 定点小数归一化 | 既有 `asIntString`/`toRawOrder` 解析路径本身（同一函数内加一路），零新解析器 |
| normalizeBookRows 计数 | 既有 `toRawOrder`（逐行判定不另写），三个取数点收敛到同一入口 |
| SourceBook rawRows/droppedRows | 既有 `SourceBook` 快照结构（可选加法字段），`DualReadRound.books` 现成穿线 |
| soak round 新字段 | 既有 `RoundRecord`/JSONL 落盘与回放机制（加法字段，消费方 report.mjs 不改即兼容） |
| discoveryStats 排除篡改 | 既有记账字段 `SubmittedRecord.tampered` + report.mjs `absorb()` 的现行口径（向它对齐，不另立定义） |
| soak 打包 | 仓库既有 esbuild（`scripts/soak/build.mjs`），命令不变 |

自有代码只有：一个正则分支、一个计数包装函数、两处字段聚合——
全部是胶水，无新依赖、无新组件。

## 未做清单（明确不在本轮）

- **节点侧 API 输出根治**：节点 `/api/orderbook` 输出 amount 时与
  price 对齐为整数串（改 `node/internal/match/engine.go` 的
  `Text('f', 18)` 回写或 API 序列化）——面更大且须先确认无其他
  消费方依赖现行小数格式，排后续节点轮。本轮在消费侧兼容两种
  形态，不依赖节点先改。
- **generator.ts 的 nodeOk 解析 body `ok` 字段**：调查已证伪
  「200 但 ok=false」形态（节点拒绝全走非 2xx），nodeOk=res.ok 在
  现行 API 合同下与业务接单等价；属健壮性优化、与根因无关，本轮
  不动，避免扩大换包风险面。
- **前端 ShadowMetrics 新增丢弃率指标**：无现成位置，不新造（见
  块 2 注明）。
- **换包与重启**：代码合并推送后由主聊天执行——在主工作树
  `frontend/` 下 `node scripts/soak/build.mjs` 重打 dist、按其决定
  把 systemd 单元的 `SOAK_NODE_URL_*` 改指本机
  127.0.0.1:8080/8081、重启 bite100-soak、回填 §6.3 新窗口起止。
  本轮未执行其中任何一步，运行中的压测仍是第 36 轮构建包。
- chain-unknown 路径绕过 SIDE_UNPROVABLE（第 37 轮 soak 事实 ②）：
  仍待裁定，不在本轮范围。

## 换包后预期（供收官核对）

新包跑起来后，round 行应出现 `nodeRawRows > 0` 且
`nodeDroppedRows` 回落到偶发坏行量级（不再等于 rawRows）；双读
firstSeen 应开始出现 node 源条目、common 计数非零——这是本轮修复
是否在活系统生效的直接判据。
