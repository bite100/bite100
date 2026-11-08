# 第 36 轮：方向不可证过渡期 + ABI 词法结尾 + soak 计时/轮转 + 准入拆 3A/3B（2026-11-08）

第 35 轮推送后 ChatGPT 复审判**不通过**，主聊天逐条核实为真。本轮只做
前端 + 脚本 + 文档（**contracts/ 与 node/ 零 diff**——协议修复明确并入
阶段 3 合约轮，不在本轮动合约）：

- **N1（高）方向证据证伪**：`Vault.lockForOrder(order, signature,
  payWithTokenIn)` 的方向参数由调用者自填、且函数自第 30 轮起无许可
  （L2），锁定代币只证明「有人按某个方向义务落了锁」，证明不了挂单人
  的真实方向；先到先得还使第三方可抢先按错误方向落锁毒化证据。第 35
  轮以锁仓方向为权威证据的 D2 口径（SIDE_UNCORROBORATED /
  EXEC_TYPE_UNPROVEN 降级、SIDE_LOCK_MISMATCH 降级）根基不成立。
- **N3**：双源同写被改 side 时两份副本一致地错——节点与中继同吃一份
  广播，来源一致不是独立证据，第 35 轮口径下这类单仍留在 VALID。
- **N2（中高）**：`check-governance-abi.mjs` 以 `indexOf('] as const')`
  定位数组结尾，数组内注释出现同一字样即静默截断后续声明。
- **N4（中）**：soak 的 `recordSubmitted` 在整批提交完成后统一打
  `submittedAt`，批次内靠前订单的传播延迟被系统性低估。
- **门禁拆分**：ChatGPT 提议、主聊天采纳——阶段 3 拆 3A（测试网合成
  压测技术准入）/ 3B（主网影子观察），见块 4。

## 0. 本轮构成与门禁结果

| 门禁 | 结果 |
|---|---|
| 前端 `npm test` | **296/296 通过**（28 文件；基线 292 + 本轮新增 4：dualread +2、RelayStatus +2） |
| 前端 `npm run build` | 通过（tsc -b + vite build） |
| relay `npm test` | **32/32 通过**（unit 20 + workers 12），本轮零改动 |
| ABI 漂移检查 + 自检 | 主检 9 条声明一致；自检 **13/13**（含 N2 新增 4 例） |
| soak 计时自检 | `npm run test:soak-timing` **8/8**（本轮新增） |
| soak 打包 | `node scripts/soak/build.mjs` 成功，产物可加载 |
| `git diff --name-only main -- contracts/ node/` | **空**（本轮红线） |

提交（分支 `round36-direction-trust`，自 main 9adf762）：块 1 / 块 2 /
块 3 / 块 4+本文档，共 4 个提交。未推送、未合并（等主聊天核验）。

## 1. 块 1 — 方向不可证过渡期：观察与认证分离（N1/N3）

**设计**：把「观察分类」与「可成交认证」彻底分开。

- 新增 `frontend/src/services/dualread/protocol.ts`：
  `SIDE_PROOF_AVAILABLE = false`，注释写明其绑定现行 EIP-712 类型集
  （`docs/eip712-order-spec.md`：Order 结构不含 side，tokenIn/tokenOut
  恒为交易对 Token0/Token1）与**解除条件**——只有协议升级轮把 side
  纳入签名结构、Vault/Settlement 链上强制执行、双链重部署完成后才
  可改 true 并接入逐单证明；仅改常量不做协议升级 = 伪造认证，禁止。
- `EvaluatedOrder` 新增 `tradableBlockers: string[]`（types.ts）：与
  `validity`/`reasons` 分开记账。过渡期每单恒为 `[SIDE_UNPROVABLE]`
  （含 INVALID/UNKNOWN 单，口径统一：认证是协议级属性）；
  `mergeBooks` 的可成交过滤改为 `VALID && !conflict &&
  tradableBlockers.length === 0` → **可成交集按构造为空**。
- **撤销**第 35 轮三条方向降级：观察分类回归状态机 + 签名 + 链上
  状态口径；`deriveSideFromLock` 保留但降为**观察提示**——落锁义务
  方向与来源自报不符时只在 reasons 记旗标 `SIDE_LOCK_MISMATCH`，
  并计入指标的同单状态一致率（metrics.ts）；相符时什么都不证明，
  绝不把任何订单推向可成交。其函数注释同步更正第 35 轮的错误
  前提（旧注释称「锁定代币不是节点可任意填写的字段」——错，
  `payWithTokenIn` 正是调用者填写）。
- execType 的未签名性质同理不再污染 validity（单源 market 声称
  观察判 VALID，认证仍被 SIDE_UNPROVABLE 关闭；execType 的链上
  强制同样只能等协议轮）。

**测试**（dualread.test.ts 新增「第 36 轮 N1/N3」describe，显式覆盖
复审场景）：

- (a) 两源同写被改 side、无锁无墓碑 → 观察 VALID、无冲突、无旗标，
  `tradableBlockers` 含 SIDE_UNPROVABLE，可成交集 0；
- (b) 两源同写被改 side + 锁按调用者自选的买方义务落锁（与自报恰好
  相符）→ 无旗标、观察 VALID，仍不可成交——第 35 轮会放行的形态，
  本轮堵死；
- (c) 两源一致的正常单（含共同声称 market）→ 观察全 VALID，
  tradeable 0，每单带 SIDE_UNPROVABLE；
- (d) 单源/双源 mismatch 三例 → validity 不动、旗标
  SIDE_LOCK_MISMATCH 仍出现在 reasons。
- 既有断言按新口径更新：单源无锁单（VALID/unlocked + 阻断码）、
  编排故障恢复轮（节点单观察 VALID、tradeable 0）等。

**产品内说明（功能变更带说明）**：`RelayStatus.tsx` 新增纯组件
`DirectionTrustNotice`（影子区常驻）：大白话写明方向不在签名范围
内、落锁方向由落锁人自选、两源一致或锁对得上都证明不了真实方向、
双读只观察不认证、可成交集暂时为空、恢复条件是协议升级；新增
`Stage3AdmissionExplanation` 承载块 4 的 3A/3B 说明（含零容忍线
过渡期自动满足的明示）。两组件各有渲染测试（RelayStatus.test.tsx
4 → 6 例）。

## 2. 块 2 — ABI 守卫词法结尾检测（N2）

`frontend/scripts/check-governance-abi.mjs`：

- 新增 `findArrayEnd(text, from)`：从数组 `[` 起逐字符扫描，状态栈
  跟踪行注释 / 块注释 / 单引号 / 双引号 / 模板字面量（`${...}` 表达
  式帧可再嵌套字符串/注释/模板，按自身 `}` 收尾），方括号深度只在
  最外层代码帧计数（字符串内的 `[]`、如 `'bytes32[] calldata
  proof'`，不计深度）。深度归零的 `]` 才是真结尾；其后仍须校验
  `as const`。注释里的 `] as const` 字样不再有任何截断力。
- `scanStringLiterals` 同步补齐 `/* */` 块注释跳过（未闭合报错）——
  否则块注释变体会在提取层被当作 junk 误报。
- 零新增依赖，扫描纪律复用既有块扫描器的逐字符状态跟踪。

**自检新增 4 例**（check-governance-abi.test.mjs，共 13 例）：行注释
`// ] as const` / 块注释 `/* ] as const */` 后接第二条**合法**声明
→ 必过且通过信息计数 = 2 条（主检查是子集口径，单看退出码分不清
「两条都提取」与「截断后剩一条也对齐」，故新增 `expectPassCount`
计数断言）；同两种注释后放**伪造**声明 → 必因漂移被拦。主检对真实
config 仍 9 条通过。

## 3. 块 3 — soak 逐单真实提交时刻（N4）+ 交易对全表轮转

**N4**（frontend/scripts/soak/）：

- `SubmitOutcome` 新增 `submittedAt`：`submitOrder` 在入口、首个
  fetch 之前打点（改写注入路径以其先行的中继投递为首个提交动作，
  同一打点覆盖）；`submitBatch` 原样透传；`SoakLedger.
  recordSubmitted` 改用 `outcome.submittedAt`，不再 `Date.now()`
  补记。JSONL 字段名与结构不变（`submitted` 行的 `submittedAt`
  字段口径变真），回放兼容旧记录。
- 新增自检 `npm run test:soak-timing`（timing.test.mjs +
  timing.entry.ts，骑仓库既有 esbuild 打包 + fetch 桩）：3 单间隔
  40ms 提交——断言 submittedAt 严格递增、间隔同量级、逐单不晚于
  其首个网络请求到达时刻、第一单明显早于整批结束（回归成批次后
  补记必挂）、落盘值与 outcome 逐字相等。8/8 通过。

**交易对轮转**（主聊天从已启动的压测现场追加的口径对齐）：第 35 轮
as-built 的生成器只轮转 BTC/USDT 一对，与 3A 门槛「全部交易对」不符。

- `main.ts` 改骑前端既有配置 `src/config/pairs` 的 `TRADE_PAIRS` /
  `DEFAULT_PAIR`（不另立平行表）：run 模式按周期轮转全表（双链同
  周期同对），评估轮次每轮覆盖全部交易对；**每周期每链单量、构成与
  提交间隔（限速）全部不变**（Sepolia 3 / Base 2 + 既有低频对抗
  样本节奏）；冒烟仍固定默认对。某对在某链未登记或钱包无可落锁
  余额时，generator 既有预检跳过并在日志给出确切原因（不注资）。
- README 同步：新增轮转与计时口径两节，骑乘表加「交易对轮转」行。

## 4. 块 4 — 阶段 3 准入拆 3A/3B（docs）

`docs/round34-nodeless-stage2-2026-11-08.md` §6.3 已按本轮口径修订
（第 1–4 条），`docs/INDEX.md` 同步（无节点设计行、第 34/35 轮行
状态、第 36 轮行）：

- **3A（测试网技术准入）**：服务端影子连续运行 ≥7 天；**≥500 张
  有效订单按链分别计数**（一链样本不替另一链补数）；零容忍线
  （共同单冲突 0、无效/未知单混入可成交集 0）；发现成功率 ≥99%；
  共同单状态一致率 ≥99.9%；**分类准确性**（与生成器真值对照）须
  报告。过渡期明示：可成交集按构造为空，混入类零容忍线自动满足、
  不算证据，3A 实际考核发现率 / 双链计数 / 一致率 / 分类准确性。
- **3B（主网影子观察）**：主网启用 active 前，先以影子模式对真实
  订单连续观察 ≥7 天，期间交易仍走节点单读，同等零容忍核对；
  **通过 3A 永不替代 3B**。
- **方向过渡规则与解除条件**：已记入 §6.3——解除 = 阶段 3 合约轮
  （side 入 EIP-712 签名 + Vault/Settlement 强制 + 双链重部署），
  与 B 开放提交实施包、ERC-1271 签名长度修复同轮捆绑。
- **压测计时口径**：2026-11-08 已在第 35 轮规则下启动的压测运行
  只计**基础设施试运行（shakedown）**；**3A 的 7 天正式计数自第
  36 轮合并起算**，届时以第 36 轮口径（全交易对轮转 + 逐单真实
  提交时刻 + 双链分别计数）运行。

## 5. 骑乘对照（集成优先核对）

| 本轮的件 | 骑乘的既有件 |
|---|---|
| `SIDE_PROOF_AVAILABLE` 协议能力常量 | 现行 EIP-712 类型集（`docs/eip712-order-spec.md` + `services/orderSigningTypes` 的 ORDER_TYPES），不另立事实源 |
| `tradableBlockers` 认证分离 | 既有 `EvaluatedOrder` / `mergeBooks` / 指标管道，只加一个字段与一道过滤 |
| SIDE_LOCK_MISMATCH 观察旗标 | 既有 `deriveSideFromLock`（降职复用）+ 既有 reasons / 一致率口径 |
| ABI `findArrayEnd` 词法扫描 | 既有 `scanStringLiterals` 的逐字符状态跟踪纪律；零新增依赖（AST 路线第 35 轮已实测不可行，结论沿用） |
| soak 计时自检 | 既有 esbuild 打包路（build.mjs 同款 define/banner）+ Node 内置 fetch 桩与文件断言，无新框架 |
| 交易对轮转 | 前端既有 `TRADE_PAIRS` / `DEFAULT_PAIR` / `getPairTokens`（`src/config/pairs`），零平行表 |
| 页内说明组件 | 既有 RelayStatus 纯组件 + renderToStaticMarkup 渲染测试模式（第 35 轮 D8 同路） |

自有代码只有：认证分离的判定胶水、词法扫描器、打点穿线与轮转编排、
文档口径修订。

## 6. 未做 / 待办（如实记录）

- **协议修复未做（按简报明确延期）**：side 入签名 + Vault/Settlement
  强制执行方向 + 双链重部署，与 B 开放提交、ERC-1271 签名长度修复
  同属阶段 3 合约轮；本轮 contracts/ 与 node/ 零 diff。在那之前，
  双读可成交认证保持关闭（SIDE_UNPROVABLE），这是刻意的 fail-closed，
  不是缺陷。
- **3A 正式压测未启动**：7 天计数自本轮合并起算，须由主聊天在合并
  后以第 36 轮口径重启 soak 服务；本轮未动正在运行的压测进程
  （其数据按 shakedown 口径处理）。轮转后各交易对在测试钱包中的
  可落锁余额未经实测——余额不足的对会被预检跳过并在日志留痕，
  3A 早期轮次须人工核对跳过日志，决定是否给测试钱包补 mock 代币
  余额（补资是 Ren/主聊天的动作，本轮未做）。
- **分类准确性目前只有口径、没有自动聚合器**：3A 要求「报告」与
  生成器真值的分类准确性；JSONL 已含 submitted 的 tampered 标记与
  每轮 filterOutcomes，人工/脚本聚合可算，但本轮未写聚合工具——
  3A 收官核对时需补一个一次性聚合脚本或在收官轮次中完成。
- execType（market/limit）同为未签名字段：本轮按同一原理撤销其
  观察降级，但它在交易页的执行语义（市价单展示/撮合）不在本轮
  范围；其可信化同样只能等协议轮（执行类型入签名或由合约强制）。
- 本轮未跑 soak 真实冒烟（需密钥与在跑的中继/节点，属主聊天的
  运行面）；soak 改动以打包成功 + 计时自检 + 产物可加载为据。
