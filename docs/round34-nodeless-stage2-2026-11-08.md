# 第 34 轮：无节点阶段 2（双读基础设施 + 影子指标 + Envio 索引器 + 中继就绪）+ M1/M2 修复 + 行情页参考价修复

日期：2026-11-08。分支 `round34-nodeless-stage2`（自 main e1049a2 第 33 轮切出）。
方案经 ChatGPT 评审（结论「需修改后执行」），修订项已全部并入本轮口径。
本轮**无合约改动**（forge 未动），不 push；主聊天验收后合并推送并按常设规则发 ChatGPT 复审。

## 0. 本轮构成与门禁结果

| 块 | 内容 | 门禁/证据 |
|---|---|---|
| 0 | 第 33 轮复审 M1/M2 修复 | go vet/test 全绿（8 包）；治理 ABI 主检查通过 + 负例自检 3 例全拦 |
| 1+2 | 2A 双读基础设施 + 2B 影子指标与隔离测试 | 前端测试 233 → 254（+21 双读测试） |
| 追加 | 行情页无成交行显示参考价（Ren 反馈缺陷） | +3 三态渲染测试（254 → 257） |
| 3 | 2C Envio 索引器 + 前端成交双源 | 索引器纯逻辑 5/5、合成事件 3/3、真实链数据回放对账 2/2、codegen 通过；前端 257 → 263（+6 合并测试） |
| 4 | 2D 中继就绪核对 + Settlement 权限事实 | relay 测试 32/32、演示 9/9（修复配置漂移后）；cast 双链回读落档（§6） |

最终树门禁（交付时复跑）：frontend `npm test` 263 全绿 + `npm run build` 通过；
relay `npm test` 32 全绿；node `go vet ./...` + `go test ./...` 全绿；
indexer `npx envio codegen` 通过 + `npm test`（纯逻辑+合成）全绿。

## 1. 块 0 — M1/M2（第 33 轮 ChatGPT 复审新发现）

- **M1（中）**：`node/internal/match/engine.go` 的 AddOrder 先删旧单后验容量，
  同 pair 跨侧替换且目标侧满员时旧单被销毁、新单被拒。改为动簿前预判
  （`checkInsertableAfterReplacement`：按「移除同 ID 旧单后」的目标侧容量
  计算），全部校验通过才移除+插入+更新索引，拒绝即零副作用。新增三边界
  测试（跨侧满员保旧单 / 同侧满员替换成功 / 跨侧未满替换成功）。
- **M2（低）**：`frontend/scripts/check-governance-abi.mjs` 解析为 0 条时
  会空过。改为：双引号声明直接报错、单引号声明数为 0 报错、任一声明解析
  失败报错、声明总数与解析数对账；新增负例自检
  `check-governance-abi.test.mjs`（空 ABI / 双引号 / 不可解析三负例 +
  真实 config 正例），并入 contracts CI。

## 2. 块 1 — 2A 双读基础设施（frontend/src/services/dualread/）

### 2.1 三态模式

`VITE_RELAY_MODE` = disabled / shadow / active（`config/relay.ts`）：
缺省 disabled；`VITE_RELAY_URL` 为空强制 disabled。**shadow 与 disabled 下
生产订单簿保持节点单读、行为零变化**（生产 hook 本轮不接线，合并视图只做
计算与指标）；active 才让合并视图进入展示。交付后生产仍为 disabled/shadow
语义，不默认 active。

### 2.2 统一订单身份与 digest 本地重算

身份 = `(chainId, settlementAddress, digest)`。digest 一律由前端既有
EIP-712 工具本地重算（域/类型唯一口径取 `services/orderSigningTypes.ts`
的 `getEIP712Domain` / `ORDER_TYPES`，**不写第二套摘要实现**），不信任任一
数据源返回的 digest 字段（中继行自带 digest 字段，适配器直接丢弃）。
签名字段重构口径与节点/中继三方一致：tokenIn/tokenOut 恒为交易对
(Token0, Token1) 与方向无关；amountOut 按第 29 轮规范整数公式
`amountIn × price / 1e18` 重算；expiresAt 为 0 时按 createdAt + 7 天推导。
规范测试向量（spec §6）已纳入单测逐字校验。

### 2.3 状态机规范（VALID / UNKNOWN / INVALID，顺序即优先级）

1. 签名订单重构失败（交易对未知/金额非法）→ **INVALID**（UNBUILDABLE）。
2. 本地验签（既有 `verifyOrderSignatureSignedData`，关浏览器时钟过期
   检查）任一副本通过即成立；全部未过时补链上
   `Settlement.verifyOrderSignature`（ERC-1271 合约签名者兜底）；链上也
   未过 → **INVALID**（BAD_SIGNATURE）；无链上快照无法补查 → **UNKNOWN**。
3. 无链上快照 / 区块过旧（最新区块 timestamp 与墙钟差 > 900 秒）/ 该单
   链上状态缺失 → **UNKNOWN**（fail-closed）。
4. 链上时间过期（**区块 timestamp** > expiresAt，不用浏览器时钟）→
   **INVALID**（EXPIRED）。
5. Settlement 累计成交 `orderFilledIn ≥ amountIn` → 终局 FILLED
   （INVALID 口径，不进可成交集）。剩余量 = 规范整数口径
   `amountIn − filledIn` / `amountOut − filledOut`（按订单自身方向计，
   OrderVolumeTracker 语义）。
6. `usedNonces(user, nonce)` 已消费且本单无任何成交 → **INVALID**
   （NONCE_CONSUMED，nonce 被别的订单占用）；本单已有成交时为合法续结，
   不触发。
7. Vault 有墓碑（`lockTombstones`）、无活跃锁（`orderLocks`）、未全成交
   → **INVALID**（LOCK_RELEASED，撤单/失败释放）。
8. 其余 → **VALID**；无锁无墓碑标 `lockState=unlocked` 仍 VALID
   （公告栏先行、落锁由提交者结算前补齐，第 30 轮 L2 无许可落锁口径）。

同 digest 两源**未签名业务字段**（side / pair / execType——这些字段不进
EIP-712 签名）不一致 → **CONFLICT**：validity 降为 UNKNOWN，不进可成交集，
只进诊断。UNKNOWN 与 CONFLICT 都不进可成交集合（fail-closed）。
软撤单口径：订单在某一源消失**不推断撤销**，一切以链上状态为准。

链上读取：viem `multicall` 批量（每单 5 项 + 按需 1 项链上验签），按区块
高度单槽缓存（同区块复用、增量补读），不逐单逐项打 RPC，不新造通用缓存
框架。两源按 (链， 交易对， 方向） 拉取、稳定排序（价格-时间-digest），
记录分页完整度（中继单侧满 100 行 = 可能截断；未拉完的数据不进完整性
指标，簿差异条目标 trustworthy=false）。

## 3. 块 2 — 2B 影子指标（口径）

展示于数据页中继状态区（`RelayStatus` 的「双读影子对比」区，仅
RELAY_MODE 非 disabled 时出现，附页内口径说明与阶段 3 准入线）。
指标定义（实现 `services/dualread/metrics.ts`，纵向部分由 ShadowObserver
跨轮累计）：

- **共同单核心字段冲突率** = 未签名业务字段冲突的共同单 / 共同单；
- **同单状态一致率** = 共同单中「无冲突 + 两源自报剩余量均与链上一致 +
  两源自报状态映射的生命周期与链上推导一致」/ 链上状态已知的共同单
  （比 digest/核心字段/剩余量/生命周期，不只比状态字符串）；
- **簿差异率**（按链/对/方向）= (仅节点有 + 仅公告栏有) / 并集，并分拆
  仅节点有 / 仅公告栏有 / 字段冲突 / 数量不同（自报 filled 不同）；
- **链上无效单比例** = INVALID / (VALID + INVALID)；
- **单源独有单比例**、**链上状态未知率** = UNKNOWN / 全部；
- **可成交误判率** = 朴素合并（只看源自报 open/partial）会展示但链上
  INVALID 的单 / 朴素可成交集；
- **订单发现延迟** = 观察器首次在某源见到该单的时刻 − 订单创建时间
  （纵向样本中位数；单次快照的「年龄」不冒充本口径）；
- **三源可用率** = 节点 / 公告栏 / RPC 各自独立统计（成功轮次/总轮次），
  不许平均掩盖；
- **分页完整度** = 各源最近一轮 complete 标记。

隔离测试（vitest，mock 三源，21 例）：状态冲突、RPC 故障→UNKNOWN、
分页截断、部分成交剩余量、链上时间过期、软撤单、故障恢复（公告栏宕一轮
后恢复、可用率分开累计）、指标计算本身。

## 4. 追加块 — 行情页无成交行显示参考价

缺陷（Ren 反馈，主聊天实测确认）：8 个交易对 6 个零成交，`MarketsList`
在 lastPrice 为 null 时只渲染「暂无成交」，丢弃了 RowCollector 已算出的
Chainlink 参考价（refUsd）；有成交的 BTC/USDT 主价是最后一笔测试成交价、
天然冻结。修法（价格格抽为 `MarketPriceCell` 三态）：

- 有成交：维持现状（主价 = 成交价，下方 $ 小字 = 参考价）；
- 无成交 + 有参考价：价格位显示参考价并标注「参考价」（与小字同为
  Chainlink 美元口径，明确不是成交价）；成交额与涨跌维持占位（—/--）；
- 无成交 + 无参考价：才显示「暂无成交」。

页脚与组件头口径说明同步改写。`useReferencePrice` 重估节奏
REEVALUATE_MS 60s → 30s（FEED_CACHE_MS 仍 30s，实际读链最快 30s/次）。
**事实记录**：Sepolia 测试网喂价约每小时更新一次（实测 ETH/USD 距上次
更新约 50 分钟），勤读无益，故不更激进。补三态行渲染测试 3 例。

## 5. 块 3 — 2C Envio 索引器（indexer/）

- **事件集合**（枚举自 Settlement 现行结算路径）：`TradeSettled` /
  `TradeSettledWithGasReimburse`（`_settleInternal` 互斥二选一，每 Fill
  恰一行 Trade）+ `GasCostShared`（gas 对半明细，独立 GasShare 实体按
  同 tx 顺序 + maker/taker 双核对关联 Trade）。批次聚合事件
  （TradesBatchSettledWithMerkle / GasSavingsDistributed）与
  FailedSettlementCharged 不索引（防重复记账 / 非成交）。
- **配置**：双链 11155111 / 84532；Settlement 地址与起始块只取第 33 轮
  部署记录（Sepolia `0xa3F8…F59f9094` 起始块 12087251、Base Sepolia
  `0x3903…DfC9E3279` 起始块 55881173，均经 CREATE tx 回执核对）；
  地址/起始块/ABI 版本标识都在 `indexer/config.yaml` 头部与
  `src/lib/settlementAbi.ts`。`disable_default_cross_chain: true`
  （per-chain 隔离；chainId 由框架自动附加，schema 不许自声明——codegen
  实测拦截过一次，已修正）。
- **digest 关联**：handler 经 `fields` 选项（HyperIndex v3.7+）取
  `transaction.input`，解码 settle 系列 calldata，按「第 i 个成交事件 ↔
  第 i 个 Fill」顺序对应后按统一规范重算；解不出留空标未关联，
  **不按地址+金额猜测**。
- **本地验证（三层分开记录，不混称 E2E）**：① 纯逻辑单测 5/5（规范向量、
  批量 3 Fill 不重不漏、垃圾 calldata 返回 null、双链 ID 分隔）；
  ② `createTestIndexer` 合成事件测试 3/3（批量 tx 两笔落库 + digest
  按序关联 + GasShare 挂载 + calldata 缺失留空 + 双链分隔）；
  ③ **真实链数据回放对账 2/2**：第 33 轮双链 E2E 结算 tx 的真实回执
  日志 + 真实 calldata 回放进 handler，实体与链上日志逐字段一致，
  makerDigest 与链上 `Settlement.orderDigest(order)` 的 eth_call 真值
  逐字一致。`envio codegen` 通过（envio 3.15.0 本机可装可跑）。
  **未做**：Envio Cloud 实时同步 E2E（需 HyperSync token / 账号，属
  部署阶段）；`envio dev` 本地全量跑需 Docker，未做。
- **部署**：步骤见 `indexer/README.md`（账号注册属 Ren）。运维事实：
  Envio 免费开发层部署最长 30 天、连续 7 天无查询可能触发删除，已写进
  README 部署步骤。
- **前端成交双源**（`services/tradesDual.ts` + `config/indexer.ts`）：
  节点 API 过渡保留；配置 `VITE_INDEXER_URL` 后 Envio 为权威展示源——
  去重键 (chainId, txHash, logIndex)，节点无 logIndex，同 tx 内按
  (maker, taker, amountIn, amountOut) 多重集配对；节点独有标「待索引」，
  Envio 独有照常展示，同 tx 同双方数量冲突以链上事件为准（抑制节点行
  并计数）。RecentTradesWidget 与数据页 Envio 状态项同步接线（探活走
  最小 GraphQL 查询）；**默认不配置时行为不变**。

## 6. 块 4 — 2D 中继就绪 + Settlement 权限事实

### 6.1 中继就绪核对

- 当前树复跑：relay 测试 **32/32 全绿**（unit 20 + workers 12），
  wrangler 实装 4.158.0（声明 ^4.45.0），runbook 命令口径无漂移。
- 本地演示复跑发现**配置漂移**并已修复：`relay/src/config.ts` 内置
  Settlement 停在第 30 轮、`scripts/demo.mjs` 与
  `scripts/verify-1271-live.mjs` 停在第 27 轮，与第 33 轮现行栈三方不一
  导致演示验签失败；统一更新到第 33 轮地址后，演示恢复 **9/9 全过**，
  ERC-1271 实链冒烟仍给出布尔裁决。教训已写进 config.ts 头注与 README：
  每次合约重部署，relay 内置配置与脚本常量必须同轮核对。
- README 所有者操作卡补第 4 步「凭据权限复核」（限定 token 仅目标账号 +
  Workers/D1 权限、不用 Global API Key、不入 Git/前端 env、部署后查日志
  无泄漏、可撤销轮换），后续步骤顺延。
- D1 核对记录（只核对不重构，落 README §2）：`db.batch()` 按一次查询
  计数（现行代码未用 batch，写入均为单语句）；唯一约束由 digest 主键
  承载（digest 按链域计算，等价 (chainId, settlementAddress, digest)
  唯一）；查询索引四条（chain+pair / chain+user / chain+order_id /
  expires_at）；过期清理双层（读路径过滤 + cron 每 15 分钟删过期超 1 天）。
- 中继**已部署**（第 36 轮后，2026-11-08）：Cloudflare Workers 免费版，
  https://bit100-relay.q3874758.workers.dev；前端已以 shadow 模式接线；
  服务端压测已连接该中继。部署由原「Ren 三步」（令牌 + Account ID 经
  Secure Vault）完成后按 runbook 执行；Workers Paid 按 Ren 指示暂缓，
  免费版 CPU 风险观察口径不变（第 35/36 轮文档）。

### 6.2 Settlement 权限事实（2026-11-08 cast 回读，双链现行栈）

| 项 | Sepolia (0xa3F8…f9094) | Base Sepolia (0x3903…FCf9) |
|---|---|---|
| `owner()` | `0x4B3fbb64ed7F3CD892484154EC684C1eFC8fa93e` | 同左 |
| `relayer()` | 零地址（未设） | 零地址（未设） |
| `isRelayer(实际提交者)` | false | false |
| 链上实际提交者（第 33 轮 E2E 结算 tx 发送方） | owner EOA 本人 | owner EOA 本人 |

结论：当前提交者模型是**过渡形态 A 的最严口径**——relayer 未设、白名单
为空，只有 owner EOA 能提交结算（其 E2E 提交凭的是 owner 身份，不是
relayer 授权）。本轮未改任何合约权限、未改 Settlement 代码。

### 6.3 阶段 3 准入门禁（含提交者模型 B 的实施口径）

提交者模型已由 **Ren 于 2026-11-08 10:17 拍板：目标定 B 开放提交**
（0x 式：任意地址可提交有效 Fill），阶段 3 实施；A（CoW 式授权提交）
仅为过渡现状。阶段 3 开工须同时满足：

1. **阶段 3A — 测试网技术准入（合成压测；第 35 轮定口径、第 36 轮拆分
   并细化）**：原口径「连续观察 **7 天**且累计 **≥500 张有效订单**」
   默认存在真实订单流——Ren 于 2026-11-08 指出本系统尚无客户、真实
   订单永远攒不满，该门槛在现阶段不可达。第 35 轮修订为**合成压测
   （synthetic soak）**，第 36 轮起正式拆为 3A/3B 两段（本条为 3A）：
   用自有测试钱包在双链、全部交易对上持续签发自造订单流（含部分
   成交、过期、跨源篡改等对抗场景），服务端影子层连续运行 **≥7 天**，
   且 **≥500 张有效订单按链分别计数**（一链的样本不得替另一链补数），
   压测期内：共同单核心字段冲突率 **0**、无效单混入可成交集 **0**、
   未知单混入可成交集 **0**、订单发现成功率 **≥99%**、共同单状态
   一致率 **≥99.9%**，并须报告**分类准确性**（双读分类与生成器真值
   的对照）。压测的观测记录在服务端逐轮落盘（JSONL），含每源首次
   发现时刻、发现成功率、订单年龄与传播延迟分开统计——第 34 轮 D7
   （浏览器内存观察器无法留存 7 天证据）由此在设计上消解。压测工具
   见第 35 轮文档（frontend/scripts/soak/）；第 36 轮起生成器按
   `TRADE_PAIRS` 全表轮转、提交时刻改逐单真实打点。
   **过渡期口径（第 36 轮，方向不可证）**：现行协议下订单方向不可
   证明（见下条），双读的可成交集按构造为空——「无效/未知单混入
   可成交集 0」两条零容忍线在过渡期是**自动满足**的，不构成安全
   证据；3A 在过渡期真正考核的是发现成功率、双链分别计数、状态
   一致率与分类准确性四项。
   **明确声明（第 37 轮补）**：**3A 过渡期通过不代表方向可信认证
   通过，不授权启用 active，也不代表具备主网可成交认证能力。**
   **「有效订单」计数定义（第 37 轮补，与 soak 台账口径对齐）**：
   一张订单计入本链的 500 线，当且仅当它**已提交**（submitted 台账
   记录存在）、**被至少一源接受**（nodeOk 或 relayOk 为真）、**未被
   标记篡改**（tampered 排除：其提交路径与正常单不同），且已度过
   **发现宽限期**（提交后 ≥60 秒，即压测台账的 graceMs）。**订单发现
   成功率 ≥99%** 由同一批记录计算：分母 = 上述合格订单数（eligible），
   分子 = 在任一轮 round 记录的 newFirstSeen 中被任一源发现的订单数
   （discoveredAny）；单列「双源发现率」= discoveredBoth / eligible。
   **分类准确性**以生成器真值为准（含 tampered 标记与生成器对每单的
   预期处置）与逐轮落盘的 filterOutcomes 对照报告；其中逐单分类准确
   性无法从 JSONL 单独导出（round 记录只保留聚合 filterOutcomes），
   只能报告聚合分类计数与发现率——该缺口已在第 37 轮文档如实登记。
   汇总工具 = `frontend/scripts/soak/report.mjs`（只读重演台账语义，
   第 37 轮）。
2. **阶段 3B — 主网影子观察（第 36 轮新增）**：主网启用 active
   （正式模式）之前，须先在主网以影子模式对**真实订单**连续观察
   **≥7 天**，期间交易路径保持节点单读、双读只观察，并执行同样的
   零容忍核对（冲突 0、无无效/未知单混入可成交集——届时方向证明应
   已随协议升级轮上线，可成交集不再为空集）。**通过 3A 永不替代
   3B**：3A 证明的是测试网合成流量下的技术保真，3B 证明的是主网
   真实流量下的行为。
   **方向过渡规则与解除条件（第 36 轮）**：第 35 轮推送后复审 N1
   证伪了「锁仓代币证明方向」——`Vault.lockForOrder` 的方向参数
   `payWithTokenIn` 由调用者自填且函数无许可。故在协议升级前，双读
   对任何订单不作可成交认证（前端 `SIDE_PROOF_AVAILABLE=false`，
   每单带 SIDE_UNPROVABLE 阻断，观察照常）。解除条件 = **阶段 3
   合约轮**：把 side 纳入 EIP-712 签名结构 + Vault/Settlement 链上
   强制执行方向 + 双链重部署，与下条 B 开放提交实施包、ERC-1271
   签名长度修复**同轮捆绑**实施；三者任一未完成，认证不恢复。
   **压测计时口径**：2026-11-08 已启动的压测运行是在第 35 轮规则
   下开始的，只计为**基础设施试运行（shakedown）**，不计入 3A；
   3A 的 7 天正式计数自**第 36 轮合并**起算（届时以第 36 轮口径
   重启计数：全交易对轮转 + 逐单真实提交时刻 + 双链分别计数）。
3. **B 开放提交实施包**：改 Settlement 调用权限（任意地址可提交有效
   Fill）+ 防滥用复核（限流/信誉机制在开放口径下重估）+ 失败 gas 归属
   复核（发起者承担口径在开放提交下仍成立）+ **双链重部署验证**
   （新栈地址回填前端/节点/中继/索引器四处配置与各自轮次文档）。
   第 36 轮补记：本包与**方向入签名协议修复、ERC-1271 签名长度
   修复同属阶段 3 合约轮、一次重部署捆绑完成**（见上条解除条件）。
   **阶段 3 合约轮同步清单（第 37 轮补，来自第 36 轮复审 §6.2）**：
   「side 入签名」必须在以下各面**原子落地**，不得拆成相互独立的
   部分提交：① 前端签名构造（ORDER_TYPES/orderSigningTypes）；
   ② 前端本地验签与 digest 重算（dualread digest.ts）；
   ③ 节点订单重建与验签（node/）；④ 中继验签（relay/）；
   ⑤ Settlement 签名校验（contracts Settlement.verifyOrderSignature）；
   ⑥ Vault 锁仓方向与已签名方向的一致性执行（lockForOrder）；
   ⑦ ERC-1271 路径（含签名长度门修复与智能钱包签名兼容）；
   ⑧ 双链部署地址与 ABI 同步回填（前端/节点/中继/索引器四处配置）；
   ⑨ 历史订单兼容或失效策略（旧协议订单的作废口径与公告）。
4. 中继已部署且影子层能持续产出上述压测观察数据（第 36 轮补记：
   中继已于 2026-11-08 部署至 Cloudflare Workers 免费版，
   bit100-relay.q3874758.workers.dev；前端已以 shadow 模式接线；
   压测由服务端 soak 工具以 shadow 模式运行）。

### 6.4 文档小修

`docs/eip712-order-spec.md` §1/§8 的第 27 轮 Settlement 地址加「历史
地址，现行地址以最新轮次文档为准」指针（评审发现其仍指向第 27 轮；
第 34 轮中继漂移事故正是抄旧地址所致，指针与事故互为印证）。

## 7. 骑乘对照（集成优先核对）

| 本轮新件 | 骑乘的既有件 |
|---|---|
| 双读 digest 重算 | 前端既有 `orderSigningTypes`（ORDER_TYPES/getEIP712Domain）+ ethers TypedDataEncoder；规范向量取 spec §6 |
| 双读本地验签 | 既有 `orderVerification.verifyOrderSignatureSignedData`（仅关过期检查） |
| 链上批量读取 | viem（既有依赖）的 public client + multicall；合约读面全部是既有 view 函数 |
| 节点书籍适配器 | 既有 `nodeClient.nodeGet` 多节点轮询 |
| 公告栏书籍适配器 | 第 30 轮 relay 现行 API 合同（零新协议） |
| 影子指标面板 | 既有数据页 RelayStatus 区（三项状态所在页）扩展，不另起页面 |
| 索引器 | Envio HyperIndex 托管服务（阶段 2 决策⑤）；解码/digest 骑 viem；测试骑官方 createTestIndexer |
| 成交双源合并 | 节点既有 /api/trades + Envio 标准 GraphQL（Hasura 口径） |
| M1 修复 | 节点既有订单簿结构与第 33 轮统一校验口径，无新抽象 |
| M2 修复 | 既有 forge 构建产物（out/*.json）做 ABI 真值源，检查脚本只加固解析 |
| 行情参考价行 | 既有 RowCollector 的 refUsd（Chainlink 喂价层，第 23/25 轮）——本轮只是把已算出的数据渲染出来 |

本轮新写的自有代码仅限：双读状态机/指标的胶水与口径逻辑、索引器
事件→实体薄映射与顺序关联、成交合并规则——均为差异化核心，无重复造轮子。

## 8. 未做 / 待办（如实记录）

- **中继已部署**（2026-11-08；第 37 轮更正本条历史表述）：Cloudflare
  Workers 免费版 https://bit100-relay.q3874758.workers.dev，前端已以
  shadow 模式接线（VITE_RELAY_MODE=shadow），服务端压测已连接中继运行。
- **Envio 索引器仍未部署**：待 Ren 注册 Envio 账号并提供令牌；
  VITE_INDEXER_URL 尚未设置，成交展示仍为节点单源——与中继状态是两件
  事，勿混记。
- 阶段 2 的真实观察数据为零：阶段 3 门槛已于第 35 轮修订为合成压测
  口径（§6.3 第 1 条），压测工具与首轮冒烟见第 35 轮文档；**压测正式
  3A 计时已于 2026-11-08 12:12 JST 启动**（第 36 轮口径重启），窗口
  至 2026-11-15 12:12 JST。
- Nostr 镜像的前端读取仍未接入（状态区如实标「未知」，沿第 31 轮口径）。
- `contracts/foundry.lock` 在本轮 M2 验证的 forge build 中被改动，属
  构建副作用，已还原，不入本轮提交。
