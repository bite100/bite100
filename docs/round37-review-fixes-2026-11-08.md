# 第 37 轮：第 36 轮复审五项最小修复（2026-11-08）

第 36 轮推送（main a0d906a）后 ChatGPT 复审判**不通过**：N1/N3/N2/N4
确认关闭，但提出两个 HIGH + 若干 MED/LOW，主聊天逐条核实为真，
Ren 拍板五项最小修复全做。本轮范围严格限定为 CI + 前端双读层 +
检查脚本 + soak 工具 + 文档（**contracts/、node/、relay/ 零 diff**，
已用 `git diff a0d906a..HEAD -- contracts/ node/ relay/` 验空）：

- **HIGH ①**：`SIDE_PROOF_AVAILABLE` 只有注释守护——evaluate.ts 把
  常量单独改 true 即给所有订单清空 `SIDE_UNPROVABLE`，不存在逐单
  证明门。
- **HIGH ②**：a0d906a 的并发「修复」反噬——GitHub 并发组全仓库跨
  工作流共享，两条 Pages 工作流同处 `pages` 组 +
  cancel-in-progress，同次推送的两个 run 会互相取消，部署结果取决
  于时序（主聊天自认此错；两文件甚至同名）。
- **MED**：ABI 扫描 `findArrayEnd` 不处理正则字面量，模板表达式如
  `${/}/}` 可能提前结束 `${}` 帧；3A 的按交易对覆盖与「有效订单」
  计数定义未汇总成文。
- **LOW**：第 34 轮文档 §8/§~193 仍称中继未部署（与事实矛盾）；
  主网计划 Kaia 费代付措辞夸大集成程度；3A 声明缺一句显式切割。

## 0. 本轮构成与门禁结果

| 门禁 | 结果 |
|---|---|
| 前端 `npm test` | **299/299 通过**（28 文件；基线 296 + 本轮新增 3，均为块 2 双读回归） |
| 前端 `npm run build` | 通过（tsc -b + vite build） |
| relay `npm test` | **32/32 通过**（unit 20 + workers 12），本轮零改动（本 worktree 先 `npm ci`） |
| ABI 漂移检查 + 自检 | 主检 9 条声明一致；自检 **16/16**（基线 13 + 块 3 新增 3） |
| soak 计时自检 | `npm run test:soak-timing` **8/8**（harness 行为未动） |
| soak 汇总自检 | `npm run test:soak-report` 通过（块 4 新增） |
| 零 diff 核对 | `git diff a0d906a..HEAD -- contracts/ node/ relay/` 为空 |
| 工作流状态 | `.github/workflows/` 下 Pages 部署工作流只剩 1 个（块 1） |

本轮提交（分支 `round37-review-fixes`，自本地 main ded73b8 起）：

| 块 | 提交 |
|---|---|
| 块 1 工作流收敛 | `973ba4b` |
| 块 2 逐单方向证明门 | `4ea33eb` + 补件 `e9eba1b`（sideProof.ts 漏入库单独补入，见块 2） |
| 块 3 ABI 词法边界 | `0af663c` |
| 块 4 3A 覆盖与计数工具 | `991466e` |
| 块 5 文档同步 | `29f5545` |
| 本文档 | 本提交 |

附注：`frontend/tsconfig.tsbuildinfo` 为 tsc 增量构建产物（仓库既有
跟踪文件），在块 1 的构建验证中被刷新入提交，无源码影响。

## 块 1 — Pages 部署工作流收敛（HIGH ②）

**动手前盘点（收敛可审计）**：

| | frontend-pages.yml | deploy-frontend.yml |
|---|---|---|
| 触发 | push [main] | push [main, master] |
| 并发 | group `pages` + cancel-in-progress（原有） | 同组（a0d906a 补入，即错误修法） |
| 结构 | build → deploy 两 job | 单 job |
| env | VITE_NODE_API_URL / VITE_RELAY_URL / VITE_RELAY_MODE（secrets） | 同三项 |
| 独有项 | — | 一步独立 `npx tsc -b`（冗余：`npm run build` 本就含 `tsc -b && vite build`）、master 触发（仓库默认分支为 main） |

**处理**：删除 `deploy-frontend.yml`；`frontend-pages.yml` 原样保留
为唯一部署链路（push main only、`pages` 组 + cancel-in-progress、
build/deploy 两 job、三项 secrets env 全在）。删除前两份 YAML 均验
证可解析，保留方删除后再次验证（jobs: build, deploy）。此后同次推送
只产生一个 Pages run，不再存在同组互取消。

## 块 2 — 逐单方向证明门（HIGH ①）

新增 `frontend/src/services/dualread/sideProof.ts`：`orderSideProof(input)`
骑乘既有 `ORDER_TYPES`（自 `../orderSigningTypes` 导入，与 digest.ts
喂给 ethers TypedDataEncoder 的是同一份类型集，不另建表）。证明成立
当且仅当：主类型 `Order` 声明方向成员（候选名 `side`/`direction`）
∧ 签名值存在 ∧ 其规范化结果（buy/sell 字符串；预留枚举 0=buy/1=sell；
预留布尔 true=buy/false=sell）与**每一份**来源自报 side 一致。现行
`ORDER_TYPES` 无方向成员 ⇒ 对今天可构造的任何订单恒返回 false。

接线：`evaluateCandidate(c, chain, opts?)` 新增可选 `EvaluateOptions
{ sideProofAvailable?, sideProofInput? }`（供测试注入，不动常量）；
`done()` 改为 `tradableBlockers = (capable && proof) ? [] :
[SIDE_UNPROVABLE]`。「不可重构」路径有意保持无条件阻断：连类型化
数据都拼不出的订单无从证明，任何协议下都应阻断。`protocol.ts` 注释
已改写为与代码一致的解除条件（常量 ∧ 本函数 ∧ 阶段 3 协议轮）。
**默认行为与第 36 轮逐字一致**（常量 false → 全员阻断）。

回归测试 +3（dualread.test.ts，该文件 40 测全过）：(a) 经 opts 强制
capability=true 且无证明 → 仍 `SIDE_UNPROVABLE`；(b) 合成未来夹具
（类型集含 `{name:'side',type:'string'}`、签名值 'buy'、自报 ['buy']）
→ `orderSideProof` 单元级为 true；(c) 成员在但值不符 / 多副本自报
不一致 / 值缺失 → false。

**入库事故如实记**：`sideProof.ts` 在 `4ea33eb` 时漏 `git add`，以
untracked 状态滞留至收尾核查才发现，已单独补件提交 `e9eba1b`。
教训：每块提交后必须 `git status` 核对未跟踪文件，不能只看提交成功。

## 块 3 — ABI 扫描词法边界（MED）

按既定路线处理（不做完整正则词法器）：`findArrayEnd`
（`frontend/scripts/check-governance-abi.mjs`）在模板帧内遇到 `${`
时抛具名错误 `TemplateExpressionInAbiError`（文案常量 `TPL_EXPR_MSG`：
声明 GOVERNANCE_ABI 数组内出现模板表达式、本检查不解析动态表达式、
请改写为纯字符串字面量）；`extractFrontendSigs` 侧 try/catch →
console.error + exit(1)。理由已写入 findArrayEnd 上方注释：正则识别
需要句法上下文，而动态表达式本就会被下游 `scanStringLiterals` 拒绝
——把静默误扫变成显式失败才是正确语义。

同路审计：字符串/注释/模板在 EOF 未闭合时扫描深度不归零 →
findArrayEnd 返回 -1 → 调用方既有路径 exit(1)，属响亮失败，保留。

自检 +3（check-governance-abi.test.mjs）：`tplRegexExpr`（反引号串内
含 `${/}/}`）与 `unterminatedTpl` 经 expectFail 在 findArrayEnd 阶段
失败；`regexInString`（普通字符串内的 `'/}/'` + 行注释）经 expectPass
仍通过——证明字符串跳过逻辑未被误伤。主检仍为 9 条声明一致。

注：本 worktree 无 `contracts/lib` 子模块，forge 构建在主树执行，
主检经 `GOVERNANCE_ABI_ARTIFACT_PATH` 指向主树产物运行。

## 块 4 — 3A 覆盖与「有效订单」计数（MED）

**先读台账语义再写工具**：`frontend/scripts/soak/runner.ts` 的
SubmittedRecord / RoundRecord 结构、`SoakLedger.discoveryStats`
（eligible = 至少一源接单 ∧ 距提交已过 grace，默认 60_000 ms；注意
其**不查** tampered 标记）、tamper 注入点（`main.ts`：`cycle % 12
=== 11` 的该链首单，生成时标记）。worktree 与主树的 runner/main/
generator 三文件经 diff 逐字一致。

**新工具** `frontend/scripts/soak/report.mjs`（只读汇总，骑乘同一份
JSONL 记录格式，不另立 schema）：参数 `--file`（必填）/ `--grace-ms`
（默认 60000）/ `--target`（默认 500）/ `--now`（默认取文件内最大
时间戳）/ `--json`。输出按链与按（链 × 交易对）的
submitted/nodeOk/relayOk/bothOk/anyOk/tampered/eligible/
discoveredAny/discoveredBoth，每链 discoverySuccessRate、
discoveryBothRate、eligibleVsTarget、meetsTarget，及轮次数、损坏行
数、各轮 filterOutcomes 合计、含可成交单的轮次数。

**一处有意的口径收紧（已写入工具头注释）**：汇总口径中篡改单单独
计数并**排除**出 eligible——比 runner 自身 discoveryStats（不排除
篡改）更严，与第 34 轮文档 §6.3 本轮补入的「有效订单」定义对齐
（已提交 ∧ 至少一源接单 ∧ 非篡改 ∧ 已过 60 秒发现宽限）。

自检 `report.test.mjs`（夹具 JSONL 于临时目录：双接/单接/双拒/篡改/
跨链五单 + 双源发现轮次 + 1 损坏行）断言 Sepolia 提交 4 / 有效 2 /
发现率 1 / 篡改 1、Base 提交 1 / 有效 1 / 发现率 0、ETH/USDT 提交
2 / 有效 0、损坏行 1、含可成交单轮次 0——全过。README 增补三条口径
事实（篡改排除、重启批次时间戳、tradeable 时间语义）。

**实盘快照（对 live JSONL 的只读副本运行，取数时文件 50 行、16 个
轮次记录、34 条 submitted，服务 active）**：

| 链 | 有效样本 / 500 | 发现成功率 | 双源发现率 | 篡改 |
|---|---|---|---|---|
| Sepolia (11155111) | 18（未达线） | 100.0% | 0.0% | 0 |
| Base Sepolia (84532) | 11（未达线） | 100.0% | 0.0% | 0 |

按对提交数：BTC/USDT 12/8（Sepolia/Base，下同）、ETH/USDT 2/1、
SOL/USDT 2/1、BNB/USDT 2/1、XRP/USDT 3/2（最新一批尚在宽限/待评估
轮次，有效计 0 属时序现象）——轮转确实已走出 BTC/USDT；DOGE/LINK/
TKA/TKB 尚未轮到。尚无任何一对出现「因余额被预检跳过」的证据形态
（但见下方缺口①：跳过不落 JSONL，只能靠进程日志佐证）。

### 本块附带查明的三件 soak 行为事实（供主聊天裁定，非本轮修复范围）

运行中的 dist 包（`~/workspace/bite100/frontend/scripts/soak/dist/
soak.mjs`，2026-11-08 03:11 UTC 构建）经核对为**第 36 轮代码**
（bundle 内 `done()` 仍是旧式单行三元式、无 sideProof 代码、
evaluateCandidate 无 opts 参数）——本轮所有 soak 侧改动只入仓库，
**未重打此包，未重启服务**（见文末约束声明）。

1. **重启批次 submittedAt**：正式计时重启后的首批 5 条 submitted
   记录按链同批共享同一 submittedAt（其 createdAt 实际相差 1 秒），
   系重启时统一落盘。submittedAt 不早于真实提交时刻 ⇒ 计数不受
   影响；该批的传播延迟统计偏乐观，引用时须注明（README 口径②）。
2. **早期轮次 tradeable > 0 是既有代码形态、非体制被突破**：前 14
   轮 filterOutcomes 合计 valid 109 / unknown 9 / invalid 24 /
   tradeable 19，tradeable 仅出现在第 1–6 轮（1,1,4,3,5,5），第 7 轮
   起恒 0（本次快照 16 轮仍为「含可成交单的轮次 6」）。原因已定位：
   第 1–6 轮链上快照失败/过期，evaluateCandidate 走 chain-unknown
   早退路径，其基础对象的 `tradableBlockers` 为 `[]`、本地验签通过
   的单 validity 为 VALID，mergeBooks 过滤据此计入 tradeable，**没有
   经过唯一挂载 SIDE_UNPROVABLE 的 done()**。第 7 轮起链上快照正常
   后全员经 done() → tradeable 0。**这是第 36 轮代码的既有疣点
   （chain-unknown 路径绕过阻断码），本轮不修（超出五项范围，且
   运行包不动）；3A 收尾读数不得把第 1–6 轮的 tradeable 当作体制
   失效，也不得当作正常样本——请主聊天裁定是否另开修复轮。**
3. **节点账本零贡献（最重要）**：前 14 轮 metrics.totals 合计
   orders 142、**common 0、nodeOnly 0、relayOnly 142**；全部
   firstSeen 均为 source=relay，节点侧发现延迟样本 0。提交侧
   nodeOk=true，却从未有一单在评估节奏内从节点源被首见、更无双源
   共同出现。原因未定（候选：节点适配器取数形态 / 节点侧订单处理 /
   传播时序），**主聊天需在引用 3A 发现率/一致率前先查清**——当前
   的「发现成功率 100%」只是中继单源的发现率，双源一致性实际上
   尚无样本可证。

### JSONL 已知缺口（如实记，不回改运行中的 soak）

- ① 生成器预检跳过（余额不足等）只写进程日志、**不落 JSONL**：
  汇总工具只能显示「某对缺席」，给不出跳过原因。
- ② 轮次记录只有聚合 filterOutcomes，无逐单评估结果：逐单分类
  准确率（对生成器真值含篡改标记）无法仅从 JSONL 导出，只能报
  聚合数 + 发现类指标。此限制已同步写入第 34 轮文档 §6.3。

## 块 5 — 文档同步（LOW）

- (a) 第 34 轮文档：§6.1 区 ~193 行「中继仍未部署」改写为已部署
  事实（Cloudflare Workers Free、
  https://bit100-relay.q3874758.workers.dev、前端 shadow 接线、
  服务端 soak 在跑；Workers Paid 按 Ren 决定暂缓）；§8（~293 行）
  拆为两条独立状态——中继已部署 vs **Envio 仍未部署**（待 Ren 的
  Envio 账号/令牌；VITE_INDEXER_URL 未设，成交仍节点单源），并补
  3A 计时注记（2026-11-08 12:12 JST 启动 → 2026-11-15 12:12 JST）。
  全 docs/ 树 grep「未部署」复核：其余命中均为历史时点属实表述
  （第 30 轮文档当时的状态、文案改版、主网未部署、NodeRewards
  §207），保留不动，此处备案为「已审计、属实」。
- (b) 主网计划第 13 行 Kaia 格：「与本项目『gas 对半收』的垫付
  模型天然契合」替换为——「Kaia 原生支持指定 fee payer 代付交易
  手续费，为平台垫付提供底层交易能力；与现有双方 gas 对半回收
  机制的集成仍需在 Kaia 部署轮验证。」
- (c) 第 34 轮文档 §6.3 补显式句：**3A 过渡期通过不代表方向可信
  认证通过，不授权启用 active，也不代表具备主网可成交认证
  能力**；同处补入「有效订单」计数定义（与块 4 工具同口径）与
  发现成功率算法、分类准确率口径及其 JSONL 导出限制。
- (d) §6.3 第 3 条补**阶段 3 合约轮同步清单**（九个面必须同轮
  原子落地，不得拆成独立的部分提交）：① 前端签名构造 ② 前端本地
  验签 + digest ③ 节点订单重构 + 验签 ④ 中继验签 ⑤ Settlement
  签名验证 ⑥ Vault 锁定方向与签名方向一致性 ⑦ ERC-1271 路径
  ⑧ 双链部署地址 + ABI ⑨ 历史订单兼容/作废处理。
- INDEX：第 36 轮行更新为已合并推送（main a0d906a）+ 复审结论；
  新增第 37 轮行（待合并，分支 round37-review-fixes，合约/节点/
  中继零 diff）。

## 骑乘对照（集成优先核对）

| 本轮的件 | 骑乘的既有件 |
|---|---|
| sideProof.ts 逐单证明 | 既有 `ORDER_TYPES`（orderSigningTypes.ts，与 digest.ts 验签同一份）、既有 evaluate.ts 的 done()/mergeBooks 过滤 |
| evaluate opts 注入 | 既有 `evaluateCandidate` 签名扩展，无新评估管线 |
| ABI 模板表达式失败 | 第 35/36 轮的字符级词法扫描器 findArrayEnd/scanStringLiterals，只加帧内分支与具名错误 |
| soak report.mjs | soak harness 既有 JSONL 记录格式与 SoakLedger 回放语义，无新 schema、无新依赖 |
| 工作流收敛 | 既有 frontend-pages.yml（原带并发组者）原样保留，删除重复件，无新 CI 机制 |
| 文档同步 | 既有第 34 轮文档 §6.3/§8 与主网计划原格改写，无新文档体系 |

新增依赖：**零**。

## 未做 / 待主聊天裁定（如实清单）

- 本轮 soak 侧改动（report 工具、README 口径、§6.3 定义）只入
  仓库；**运行中的 3A 计时包仍是第 36 轮构建**，新工具在 3A 收尾
  （2026-11-15）时由主聊天对全量 JSONL 运行即可，无需中途换包。
- chain-unknown 路径绕过 SIDE_UNPROVABLE（块 4 事实②）：是否另开
  修复轮，待裁定；注意修它需要动 evaluate.ts 并重打 soak 包，与
  「3A 计时中途不换包」如何协调一并裁定。
- 节点账本零贡献（块 4 事实③）：原因未查，待主聊天调查；查清前
  3A 的双源一致率无样本支撑。
- Envio 部署仍待 Ren 的账号/令牌（与本轮无关，状态未变）。
- 本轮未 push、未 merge——按分工由主聊天核验后执行，其后照例走
  推送后 ChatGPT 增量复审。

## 约束遵守声明（soak 零触碰）

生产 soak（systemd `bite100-soak`，2026-11-08 12:12 JST 正式 3A
计时中）本轮全程未重启、未停止；其运行包
`~/workspace/bite100/frontend/scripts/soak/dist/` 未重打、未覆盖
（文件时间仍为 2026-11-08 03:11 UTC 构建时刻）；数据目录
`~/workspace/bite100-soak/` 只读查看，汇总工具仅对其 JSONL 的
/tmp 副本运行。收尾时复核服务状态为 active。
