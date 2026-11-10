# 第 62 轮：订单 nonce 顺序水位 → Permit2 式无序位图

> 设计依据：`~/workspace/research_notes/bit100-r62-nonce-bitmap-2026-11-10/report.md`
> （Permit2 一手语义核对、逐文件影响面、回归清单 §4.4、开放问题裁定）。
> 基线：main @ 0c7d814。分支 `round62-nonce-bitmap`。本轮只施工 + 本地
> 提交；部署（新 Settlement 重部署 + 前端/索引切换）是主聊天验关后
> 的独立一步，不在本轮内。

## 1. 本轮要解决什么

旧语义：`Settlement` 用「顺序水位」管订单 nonce——`userNonces` 只进
不退，`useNonce` 要求 `nonce == 当前水位`。后果是**同一用户的订单
必须严格按 nonce 顺序结算**：先签的单没结，后签的单哪怕先撮合上也
结不了（水位没到）；一张单卡住，后面全部排队。真实交易里撮合顺序
天然乱序，这是结构性误杀。

新语义（Permit2 无序 nonce 位图，逐字借其已审计实现）：每个用户一
张 2^248 字 × 256 位的位图，`nonce` 的高 248 位选字、低 8 位选位；
结算时只检查并置该一位。**任何顺序可结**；作废一张单 = 把它那一
位置位（`invalidateUnorderedNonces`），与顺序无关。订单结构、
EIP-712 类型串与 digest 公式**逐字不变**（§5 机器证明）。

用户可见变化（功能变更同轮带说明，规范 §10 同轮更新）：

1. **乱序可结**：同账户订单不再要求按签发顺序结算。
2. **链上点杀撤单原语**：持单人可付 gas 把某张未开始订单的 nonce
   位置位，该单自此链上不可结算；已部分成交订单的续结不由此阻止，
   须走金库硬撤（口径修正见 §6；与中继签名撤单构成双档模型，§6）。
3. nonce 由前端**位图分配器**发放（localStorage 游标 + 链上位图播
   种 + 在途占用跟踪），`fetchOrderNonce` 函数签名不变，MCP 借道
   自动跟随。

## 2. 设计与调研的对应关系

| 调研条目 | 落地块 | 说明 |
|---|---|---|
| §1 Permit2 语义（位图/消耗/失效/先消耗后验签） | 块 A | 语义逐字借；**集成顺序不跟随**：Bit100 保持先验签后消耗（§1.3 集成判断——我们的验签在独立 `_verifySignedOrder` 阶段，nonce 消耗在落锁段） |
| §2.1 EIP-712 digest 不变 | 块 A/B/F | Order 结构与类型串零改动；不变性由三方冻结向量机器证明（§5） |
| §2.2 合约改动集中在 OrderNonceManager | 块 A | Settlement 仅 `_consumeOrderNonce` 一处判定换位测试 |
| §2.3/§4.3 客户端分配器是真正的活 | 块 C | 新 `nonceAllocator.ts`；游标模式骑阶段 4 跑手既有 `nonceCursor` 形态 |
| §4.2 规范改文清单 | 块 B | §2/§4/§8 改文 + 新增 §10 切换注 |
| §5.2 中继在途撞号兜底 | 块 D | 主聊天裁定纳入本轮：D1 条件插入 + 409 |
| §4.4 回归清单 1–12 | 块 F | 逐项落地（§4 对照表）；第 13 项（Sepolia 实盘冒烟）属部署步 |
| F1 三件套 / OZ 验签换装 | 块 E | 只评估不施工（§7、§8） |

## 3. 改动清单

### 块 A · 合约

- `contracts/src/OrderNonceManager.sol` **重写**：删除
  `userNonces`/`usedNonces`/`getCurrentNonce`；新增
  `mapping(address => mapping(uint256 => uint256)) public nonceBitmap`
  （Permit2 同名同形）；`bitmapPositions` 逐字借
  （`uint248(nonce >> 8)` / `uint8(nonce)`）；`useNonce` 改 XOR 位图
  消耗（已置位 revert `InvalidNonce()`、保留 `NonceUsed` 事件）；
  `isValidNonce` 改位测试（签名不变）；新增 external
  `invalidateUnorderedNonces(wordPos, mask)`（Permit2 逐字借 +
  `UnorderedNonceInvalidation` 事件）。零地址守卫保留（Bit100 既有
  口径，Permit2 本尊无此项）。
- `contracts/src/Settlement.sol`：`_consumeOrderNonce` 的已用判定换
  位测试（`!manager.isValidNonce(...)` → revert InvalidNonce），删除
  「单调水位」注释表述。其余（Order 结构/TYPEHASH/验签/累计成交/
  落锁/gas 规则）**零改动**。
- 既有测试的 nonce 断言迁移到位图口径：`Settlement.t.sol`
  （PartialFills 续结）、`MakerVault.t.sol:220`、`VaultLocking.t.sol:436`；
  新增 6 条位图语义测试（乱序结、先 5 后 2；字边界 255/256；失效
  点杀 + 相邻位不受影响；整字全杀语义；不能动他人位图；已部分
  成交单失效后续结不受影响）。

### 块 B · 规范文档

`docs/eip712-order-spec.md`：§2 nonce 行改位图口径；§4 第 5 条删水
位表述、补位图消耗与失效语义（独占 + 部分成交续结保留）；§8 合约
用户条同步（`useNonce` 位图消耗、`invalidateUnorderedNonces` 新条）；
新增 **§10 第 62 轮切换注**：类型哈希不变、旧单因重部署换地址
（域分隔符变）作废，与阶段 3 的作废机理（改类型串）明确区分。

### 块 C · 前端分配器

- 新 `frontend/src/services/nonceAllocator.ts`：状态
  `{cursor, inFlight}` 按 `bit100:nonce-cursor:{chainId}:{地址小写}`
  存 localStorage（不可用时内存 Map 兜底，MCP 的 Node/Worker 环境
  走此路）；`allocate` 先剪除在途集合中链上已置位的项（已结算回
  收），再从游标起找「链上未置位 ∧ 不在在途」的最小 nonce 发放并
  记入在途——游标与链上冲突时天然以链上为准（每位发放前都查链上
  位图）。
- `orderSigning.ts`：`fetchOrderNonce` 签名不变，内部换分配器；内
  嵌 ABI 片段换 `nonceBitmap(address,uint256)`。三个下单入口与
  MCP `orderBuild` 零改动自动跟随。
- `settlementAbi.ts`：`getCurrentNonce` 条目删除，换
  `nonceBitmap`/`isValidNonce`/`invalidateUnorderedNonces` 三条
  （逐字取自本轮构建产物）。
- **调研外发现并同轮迁移**：`dualread/chainState.ts` 的链上状态读
  取直读 `Settlement.usedNonces(user, nonce)`（已删除）——改读
  `nonceBitmap(user, wordPos)` 并在本地做位测试（`assembleChainState`
  新增 `bitPos` 参数，调用方传 `nonce % 256`）；其测试 mock 同步
  迁移并新增 1 条位测试装配用例。
- `scripts/soak/generator.ts`：`currentNonce()` 播种读法换位图扫描
  （从 word 0 找首个未满字、字内取最低未置位）；`nonceCursor` 本体
  不动。stage3-e2e 两个驱动的状态打印改读 `nonceBitmap` word 0。
- 多腿对账脚手架迁移（块 F 第 10 项载体）：Go 多腿测试终局快照、
  前端两驱动 `nonces` 字段、compare-multileg 第 6 项断言统一改位
  图 word 0 口径（详见 §4.1）。
- `orderSigningTypes.ts` 两处注释、`mcp/src/tools/write.ts` 一处注
  释同步新口径（MCP 代码零改动）。

### 块 D · 中继在途撞号兜底

`relay/src/index.ts` `POST /orders`：插入改**条件 INSERT**
（`INSERT ... SELECT ... WHERE NOT EXISTS(...)`）——同一
(chainId, userAddress, nonce) 已有**另一 digest** 的 live 订单
（status open/partial 且未过期）时新单不落库，返回 **409
`{error: 'nonce_in_flight'}`**；检查与插入单语句完成，无查/插竞
态。同 digest 重投走既有幂等路径（去重前置 + 并发竞态回落
duplicate:true）。**只查 D1、不查链上 nonce**（中继无链上状态依赖
的设计不变）。测试 helpers 默认 nonce 改自动递增发号（模型化真实
客户端行为）并新增第二测试账户；workers 新增 6 条（撞号拒绝/同
digest 放行/过期不拦/非 live 状态不拦/跨用户不拦/跨链不拦）。

## 4. 基线与门禁实测（本轮 pristine 实测，非沿用旧轮数字）

| 门禁 | 基线（0c7d814） | 本轮终值 | 增量来源 |
|---|---|---|---|
| forge 全套 | 217/217 | **223/223** | +6 位图语义新用例 |
| 前端 vitest | 474（40 文件） | **482（41 文件）** | +7 分配器、+1 双读位测试 |
| 前端 tsc + build | 通过 | 通过 | — |
| MCP 测试 + typecheck | 89 | 89（零改动复核） | — |
| relay unit | 52 | 52 | — |
| relay workers | 26 | **32** | +6 块 D 撞号用例 |
| relay tsc | — | 通过 | — |
| anvil 端到端（多腿双路对账） | — | 见 §4.1 | 调研 §4.4 第 10 项 |

调研 §4.4 对照：1 乱序核心用例 ✔（forge `test_SettleOutOfOrderNonce5ThenNonce2`）；
2 独占保留 ✔（`SameNonceDifferentOrderReverts` 原样通过，未改）；
3 部分成交续结 ✔（断言改位图口径后通过）；4 失效点杀五义 ✔（新
用例 4 条）；5 字边界 ✔；6 MakerVault/VaultLocking 断言迁移 ✔；
7 分配器单测 ✔（7 条）；8 前端全套 ✔；9 三方 digest 平价 ✔（§5）；
10 anvil 端到端 ✔（§4.1）；11 relay 全套 ✔；12 MCP 下单覆盖 ✔
（MCP 测试以 stub signer 注入生产 `fetchOrderNonce` 跑下单全路径，
分配器换装后 89 条原样通过；且 MCP 包零代码改动——其 deps 解析到
同一 frontend 源码，分配器自动生效）；13 Sepolia 实盘冒烟 → 部署
步执行。

### 4.1 anvil 端到端记录（调研 §4.4 第 10 项）

载体：第 43 轮多腿双路对账脚手架 `frontend/scripts/stage3-e2e/run-multileg.sh`
（同一场景在 anvil 上跑节点路径与前端路径两遍后逐项对账）。本轮
为它做了位图迁移：Go 多腿测试的终局快照与前端两驱动的 `nonces`
字段改报 `nonceBitmap` word 0，compare 第 6 项改按「从 0 顺序消耗
n 枚 ⇔ word0 = 2^n − 1」断言。

实测结果（2026-11-10）：

- **节点路径 PASS（243.03s）**：部署、撮合（S1–S5 全场景，含 55 腿
  批量）、结算、终局对账在新位图合约上全过；产出快照
  nonces = {maker `36028797018963967` = 2^55−1, taker `15` = 2^4−1,
  owner `1`}，与 compare 新期望逐字一致——位图消耗集合与旧顺序计
  数口径（55/4/1 枚）在真实执行上等价得证。
- **前端路径未走完，卡点与本轮无关（基线对照定责）**：S1（3 腿多
  档）、S2（部分成交 + 余量）完成；S3 结算 ml-m5 时 revert
  `Vault: order cancelled`。以基线 main@0c7d814 在同一脚手架复跑，
  前端路径在**同一场景、同一笔交易**上以逐字相同错误失败——此为
  第 47 轮 Vault `cancelledOrders` 墓碑与第 43 轮脚手架 S3（陈旧
  腿）场景之间的既有不兼容，**不是第 62 轮回归**（本轮零改动
  Vault、订单 digest 不变、S3 之前的前端路径行为与基线一致）。
  compare 因此未执行；其前端路径 word 0 期望（2^61−1 / 2^5−1）按
  同一换算公式给出、未经执行验证，如实记于此，待脚手架 S3 与墓
  碑口径对齐轮（既有问题，非本轮范围）修后复跑补验。
- 同账户乱序双单场景由 forge 用例
  `test_SettleOutOfOrderNonce5ThenNonce2` 在合约层证明（先结
  nonce 5 再结 nonce 2 均成功），anvil 层由节点路径的乱序撮合结
  算全程覆盖。

## 5. digest 平价断言落点（digest 不变的机器证明）

同一固定输入（规范 §6 向量：anvil 账户 #0、nonce 0、side=1 的卖单）
在三处独立断言与第 62 轮之前**逐字相等**的摘要
`0xd793d795036c2d1b548120e9e73ea43a608529b4a23f0d3254c263fde391cec0`
（BUY 变体 `0x15842043…6b96` 亦然）：

1. 合约：`contracts/test/Stage3PriceFix.t.sol::test_FrozenDigestVector`
2. 前端：`frontend/src/services/dualread/dualread.test.ts`（同值断言）
3. 中继：`relay/test/unit/orders.test.ts` 跨语言向量用例（同值断言）

三处在本轮代码上全部原样通过、断言值未改一字——Order 结构、类型
串、域构造与结构哈希均未被本轮触碰的形式证明。

## 6. 双档撤单模型（用户向说明）

用户签发的订单在结算前有两条作废路径，档位不同、代价不同：

- **普通撤单（中继签名撤单，后续轮次上线）**：用户签一条撤单消息
  给中继，订单立即从订单簿下架。免费、即时；但它只管订单簿——订
  单签名本身在链上仍有效，若有人在撤单前已拿到签名并抢先提交结
  算，链上仍会成交。它防的是「日常撤单」，不是「签名已外泄」。
- **链上点杀（本轮原语 `invalidateUnorderedNonces`）**：用户直接
  发一笔链上交易把该单的 nonce 位置位，订单签名自此在链上**永久
  不可结算**，任何人拿着签名也结不了。代价是付一笔 gas；不可逆
  （置位不能撤销）；一张单一个位，点杀不误伤其他单。
  **口径修正（第 62 轮审查 P1，2026-11-10）**：上句的「永久不可结
  算」只适用于尚未开始成交的订单。已部分成交的订单，其 nonce 在
  首笔成交时已经置位，续结走 continuation 放行，点杀对它不起新增
  作用；要停掉一张已部分成交的订单，必须走 Vault 的锁释放/硬撤
  路径（releaseOrderLock + cancelledOrders 墓碑）。后续前端撤单流
  程必须按订单状态分流：未开始 → 点杀；已部分成交 → 硬撤，不得
  只调用位图接口。此分流为签名撤单后续轮的验收项。

**粒度陷阱（后续 UI 轮硬要求，先记于此）**：失效接口按「字 + 掩
码」工作，一个字含 256 个 nonce。给单张单做点杀时，掩码**必须逐
位构造**（`1 << (nonce % 256)`，只含目标单一位）；整字全杀
（mask = 2^256−1）会连带作废同字内最多 255 张其他未结订单。未来
UI 若提供整字全杀（紧急止血场景），必须**明示将受影响的在途订单
数量并要求二次确认**——此为后续 UI 轮的验收硬项，不得省略。

## 7. 块 E 评估一：F1 Settlement 三件套删除评估（只评估，未施工）

证据口径：全仓引用面（合约/前端/中继/MCP/索引器/脚本/测试）+
双测试网现行 Settlement 自部署块起的全量事件计数（cast logs，
2026-11-10 实查）。

### 7.1 RelayerReputation（中继信誉）——结论：缓删（与中继名单定版捆绑清理）

- 合约面：`RelayerReputation` 结构（L47）、`relayerReputation` 映射
  （L53）、`minRelayerReputation=5000`（L54）、初始分常量；写入口
  `_initRelayerReputationIfNeeded` 仅被 `setRelayer`/
  `setRelayerAllowed` 在授权时调用；`recordRelayerViolation`
  （onlyOwner，L381）与 `setMinRelayerReputation`（L396）为外部面；
  事件 `RelayerReputationUpdated`/`RelayerViolationRecorded`。
- **死代码实锤**：`_checkRelayerReputation`（L359）与
  `_updateRelayerReputationSuccess`（L368）在合约内**零调用者**——
  信誉既不拦结算也不随成功加分；测试名即口径
  （`test_RelayerReputation_NoResetAndNoLongerGatesSettlement`，
  Settlement.t.sol:248）。现行仅剩「授权时写一个初始分 + 发一个事
  件」的惰性足迹。
- 链下引用面：前端/中继/MCP/撮合引擎**零引用**（前端 ABI 甚至未收
  录其任何条目）；仅测试 2 条 + NodeRewards.t.sol 注释一处提及。
- 链上证据：双链 `RelayerReputationUpdated` 事件 **0 / 0**；
  `relayer()` 双链均为零地址（模型 B 开放提交，中继名单从未启
  用）；`minRelayerReputation` 读回 5000（出厂默认）。
- 结论与影响面：行为上删之无损，但它与 `setRelayer`/
  `setRelayerAllowed` 名单面纠缠（初始化挂在授权路径上），而名单
  本身去留是「中继模型定版」的产品问题，不宜在本轮外单独动。**
  缓**：待中继模型定版轮把「信誉整块 + 名单面」一并处置；若删，
  范围 = 结构/映射/阈值/初始化/检查/记分/违规/设置器/两事件 +
  测试 2 条，约 120 行，无链下影响。

### 7.2 GasSavingsDistributed 回扣批量入口——结论：留（功能待接线，非死代码）

- 合约面：`settleTradesBatchWithGasSavings`（L888）+ 内部
  `_distributeGasSavings`（L978）：结算本体与 `settleTradesBatch`
  同核；`gasSavingsUsdt6 > 0` 时把节省额的 25%/25% 分给
  FeeDistributor 与创始人奖励（经 NodeRewards），调用者先行
  transferFrom 垫付——是**独立功能**，不是批量结算的重复实现。
- 引用面：前端仅 ABI 收录（函数 + 事件），无调用点；索引器
  association 对其选择器做 digest 关联（防御性收录），事件本身明
  确不索引（settlement.ts:9 注释）；测试有实质覆盖：NodeRewards
  配对 2 条（未配对 revert / 配对后成功）+ Stage3PriceFix 坏腿整
  批回滚 1 条（骑此入口作批量代表）。
- 链上证据：双链 `GasSavingsDistributed` 事件 **0 / 0**，但须注意
  该事件只在分配条件全备时 emit；现行双链 `nodeRewards()` /
  `founder()` / `usdtToken()` **全为零地址**——分配路径在当前部署
  上结构性不可能触发，属「未接线」而非「被调用过且失败」。零节省
  路径与普通批量逐位等价，事件计数无法区分，未据此声称零调用；
  结论依据的是接线状态 + 无链下调用点。
- 结论：**留**。它是 NodeRewards 产品线（待负责人启用）的前置入
  口，删之等于拆未启用的功能而非清死代码；主网接线时（设置
  usdtToken/founder/nodeRewards）自然激活。若主网定版决定砍
  NodeRewards 产品线，再与之同轮删除。

### 7.3 TradesBatchSettledWithMerkle 批量入口——结论：删（候选，独立清理轮执行）

- 合约面：`settleTradesBatchWithMerkle`（L1001）+ `_fillLeaf`
  （L856）+ 事件（L216）+ MerkleProof 导入的唯一合约内用途。功能
  = 普通批量结算外加「成交集合的 Merkle 根校验」，结算仍逐笔验
  签——根校验不提供任何链上安全增量，纯审计便利包装。
- 引用面：前端仅 ABI 收录、无调用点；索引器 association 收录其
  选择器、事件明确不索引；测试仅 Stage3PriceFix 坏腿 1 条骑用
  （可平移至 `settleTradesBatch`，该文件已有普通批量用例）。
- 链上证据：该事件在入口内**无条件 emit**，双链计数 **0 / 0** 即
  「自部署以来从未被调用过」的完全证明。
- 结论：**删**（本轮只评估，执行放独立清理轮）。删除面：合约函数
  + `_fillLeaf` + 事件 + MerkleProof 导入（Settlement 内）；前端/
  索引器 ABI 条目各 1 + association 分支 1；测试 1 条平移。链下无
  行为影响；Envio 已逐笔索引每笔 Trade，主网审计需求不依赖批次
  根。

## 8. 块 E 评估二：Settlement 验签换 OpenZeppelin EIP712 + SignatureChecker

### 8.1 现行手写面盘点（Settlement.sol）

| 件 | 位置 | 形态 |
|---|---|---|
| 域类型哈希/名/版哈希常量 | L146–150 | 手写常量（`_DOMAIN_TYPEHASH`/`_DOMAIN_NAME_HASH`/`_DOMAIN_VERSION_HASH`） |
| `domainSeparator()` | L616 | 每次调用现算（无缓存）；公式 = 标准 EIP-712 |
| `_orderDigest` | L624 | 手写结构哈希 + `"\x19\x01"` 拼包 |
| `verifyOrderSignature` | L653 | 手写 `_splitSignature` + 原生 `ecrecover`；阶段 3 的签名长度门设计（65B 且 v 合法 → ECDSA 快路径；其余形态只要地址有代码一律交 ERC-1271；无代码地址直接 false） |
| ERC-1271 回退 | L664 | **已骑 OZ** `SignatureChecker.isValidSignatureNow` |

仓库 OZ 依赖：5.6.1（foundry remapping 在册）；同仓先例：MakerVault
已用 OZ `ECDSA.tryRecoverCalldata` 实现 isValidSignature；第 61 轮
Governance/MerkleDistributor/Settlement 已把手写 MerkleProof 换 OZ
同名库（叶子构造冻结、回归通过）。

### 8.2 换装方案与 digest 不变性论证

- 域：继承 OZ `EIP712`，构造传 `("比特100", "1")`。OZ 的
  `TYPE_HASH` 与本仓 `_DOMAIN_TYPEHASH` 为同一字符串的 keccak；
  名/版哈希由构造时对同字符串求哈希，与现行常量逐位相等；
  `_domainSeparatorV4` 公式（字段序：typeHash, nameHash,
  versionHash, chainId, verifyingContract）与现行 `domainSeparator()`
  逐字同构。OZ 有缓存 + 分叉重算逻辑，现行是每次现算——同链同地
  址下输出恒等，分叉语义等价。
- 摘要：`_hashTypedDataV4(structHash)` 与现行
  `keccak256("\x19\x01" ‖ domainSeparator ‖ structHash)` 同式；结构
  哈希（`_ORDER_TYPEHASH` + 字段编码）**不动**。
- 验签：EOA 路径换 OZ `ECDSA.tryRecover(digest, signature)`（错误
  以返回值交回，可保持「失败不 revert、继续走 1271」的现行控制
  流）；删除 `_splitSignature`；阶段 3 长度门**保留在本仓代码里**
  （它是 Bit100 的语义设计，不是 OZ 的事）。
- **一处真实语义差，必须明示**：原生 `ecrecover` 接受高 s 签名
  （可锻性），OZ ECDSA 按 EIP-2 拒绝高 s。换装后高 s 的 EOA 签名
  将落空（无代码地址 → false）。主流钱包一律产低 s，此为收紧而
  非破坏，但属可观察的行为变化，换装轮须有专门用例钉住并在轮次
  文档声明。
- 外部面：`domainSeparator()` 现行是 public——链下零调用者（前
  端/中继/MCP/索引器均未读，仅测试可能引用）；换装时保留一个同
  名薄封装转调 `_domainSeparatorV4()` 即可保 ABI 不变。
- 机器证明路径：现成的三方冻结向量（§5 三处断言）就是换装的验
  收门——向量若逐字通过，digest 不变即被证明，与本轮第 9 项同一
  机制；另加 MakerVault（ERC-1271）代签全路径回归（中继 unit 的
  金库单用例 + 合约 MakerVault 套件）。

### 8.3 范围、风险与结论

- 范围：仅 Settlement.sol（约 −50 行手写密码学管道）；构造器新增
  `EIP712("比特100", "1")` 初始化；测试面 = forge 全套 + 三方冻结
  向量 + 1271 回归 + 新增高 s 用例。前端/中继/MCP/索引器零改动
  （摘要与 ABI 均不变）。
- 风险：① 构造参数笔误（unicode 名）——冻结向量当场拦下；② 高 s
  收紧——如上明示；③ OZ 缓存分隔符与链分叉——OZ 内建 chainId 变
  化重算，与现行每次现算等价。
- **结论：做，但独立成轮，不与任何语义轮同行。** 理由：收益真实
  （删手写验签管道、与第 61 轮 OZ 化先例同轨、符合集成优先站
  规），但它动的是签名热路径——按本轮「单变量纪律」，nonce 轮不
  捎带它；排进下一个 Settlement 触碰轮（桥加固/气库时代）或专门
  的验签加固轮，门禁 = 三方冻结向量未改一字全过。

## 9. 骑乘对照表（站规：每件新东西骑哪个既有件）

| 本轮新件 | 骑乘的既有件 |
|---|---|
| 位图消耗/失失效语义 | Permit2 `SignatureTransfer`/`AllowanceTransfer` 的无序 nonce 语义与表达式逐字借（已审计实现），未自创 |
| `nonceBitmap` 命名与形状 | Permit2 同名同形（链下工具/审计师零学习成本） |
| 前端分配器游标形态 | 阶段 4 跑手 `nonceCursor`（soak/stage4 已实证的本地游标模式）产品化 |
| 分配器状态存储 | 浏览器 localStorage（平台能力）；Node/Worker 内存兜底 |
| 中继撞号检查 | 中继自家 D1 既有订单表 + SQLite 条件插入（无新存储、无链上查询） |
| digest 平价门禁 | 第 60/61 轮已落地的三方冻结向量（规范 §6 向量三处断言）零新增 |
| 块 E 评估的链上证据 | cast logs / cast call 对现行部署直查，无新工具 |

自有代码只出现在：消耗语义的接线（Settlement 一处判定）、分配器
的在途记账、撞号 SQL、文档——即站规所说的「胶水 + 差异化核心」。

## 10. 诚实遗留

1. **多端撞号窗口只能缩小、不能根除**：分配器是单设备本地状态；
   同一钱包在两台设备（或网页 + MCP 两进程）同时下单，仍可能签
   出同 nonce 的两张不同订单。防线分层：签发侧分配器（单端根
   除）→ 中继撞号拒绝（入库侧兜底，本轮块 D）→ 链上独占规则
   （最终仲裁：先结者赢，后结者 InvalidNonce）。残余窗口 = 两张
   单绕过同一中继实例的极端并发（条件插入已原子化，中继侧实际
   只剩「不同中继/镜像各收一张、结算时才见分晓」——链上仲裁兜
   底，损失上限是一张单作废，不产生错结）。
2. **中继兜底的边界**：只看自家 D1 的 live 状态；已被前端撮合消
   耗但中继状态未更新的订单（中继状态本就由服务端在入库时生
   成、结算状态不回写中继）在过期前仍占位——与链上语义一致
   （nonce 未置位前该单确实仍可结），不构成误拦。
3. **在途集合只记本设备签发**：分配器的 inFlight 不含其他设备/
   路径签出的单；链上位图播种只能看见已结算的位。故跨设备场景
   依赖第 1 条的分层防线。
4. **`getCurrentNonce` 删除的连带**：所有仓内调用点已同轮迁移
   （§3 块 C，含调研未列的 dualread 一处）；仓外若有未入库脚本
   读它，部署后会失效——已知调用面已全仓 grep 清零。**一处例外如
   实记录**：已退役 Go 节点自带的其余 e2e 测试脚手架
   （`e2e_anvil_test.go`/`e2e_locking_test.go`/
   `e2e_market_anvil_test.go`/`e2e_sepolia_test.go`）仍引用
   `getCurrentNonce` 且内嵌旧水位断言，本轮未迁——它们是阶段 5
   已退役节点的自带测试、不在任何现行门禁路径上（与第 51 轮
   soak 的 ShadowObserver 断裂同类处置：记录在案、不修）；多腿
   对账脚手架是现行端到端门禁，已同轮迁移（§4.1）。
5. **多腿脚手架前端路径 S3 既有失败**（第 47 轮墓碑 × 第 43 轮场
   景，基线对照实证与本轮无关）：见 §4.1。修复归脚手架对齐轮，
   不在本轮范围；在此之前该脚手架以前端路径 S1/S2 + 节点路径全
   过为可用状态。
6. 本轮**未部署**：位图语义须待新 Settlement 重部署才在测试网
   生效；重部署后旧栈订单因域分隔符变化整体作废（规范 §10 已注
   明），部署步须按既有换栈流程切换前端/中继链配置与 Envio 部署。

## 11. 本地提交

| 提交 | 内容 |
|---|---|
| `8db815d` | 块 A+B：OrderNonceManager 位图重写 + Settlement 位测试 + 规范改文（forge 223） |
| `4a8ccd5` | 块 C：前端位图分配器 + dualread 迁移 + ABI/注释同步（vitest 482） |
| `32b6a59` | 块 D：中继撞号兜底 + 测试（workers 32） |
| `4029eb2` | 块 F-10：多腿对账脚手架位图迁移（§4.1） |
| （本文档提交） | 块 E 评估 + 块 G 轮次文档 |

## 12. 部署记录（2026-11-10，部署步）

**路径判断：只部署新 Settlement + 现行 Vault 改指，不换 Vault。** 依据：
`Vault.setSettlement` 是 owner setter，支持改指；Settlement 的 vault 指针在
构造期设定，新实例构造时指向现行 Vault 即可；关键安全点是 Vault 的锁释放
路径（`releaseOrderLock` / `releaseExpiredOrderLock`）不经 Settlement 调用，
改指后旧订单的剩余锁定仍可由用户/locker 释放，不会困资。旧订单因 EIP-712
域绑定 Settlement 地址随换址整体作废（与整栈更换同口径，§10.6）。用户余额
留在现行 Vault 原地不动。部署脚本 `contracts/script/DeployR62.s.sol`（仿
DeployStage3 的配置复制法，另加 feeDistributor 与 governance 读回核对断言）；
MakerVault 已退役不部署；Governance / ContributorReward 不动；旧 Settlement
原样保留作回滚（Vault 改指回旧地址即回滚）。

| 链 | Vault（不换） | 旧 Settlement（回滚） | 新 Settlement | CREATE tx | 部署块 |
|---|---|---|---|---|---|
| Sepolia | 0x836cEFF0140aB66D8DD984ECb18765736BA121e9 | 0x5697F7B2178352eB391e29fc2c5681Dea864C1d9 | **0xa38c087778d76DA30654F30CB87D1ddD83f7b263** | 0xd8e7d3eef6a2b997a451a63616518224b47ebae518578952572583aa6cca54cc | 12102776 |
| Base Sepolia | 0x295F5529F5BfA4cA39290f395b1feF7EA637f5D3 | 0x1021C7116cCE59f9c85683d6f1b5aD2215795949 | **0x4969b9ACBe7Dbf57E150FcF413B622c2912e2e97** | 0xb8e3fb3c00e4629805fc487cae057e4bad50b0e0ba0e5177b34df287985a60a5 | 56845937 |

配置回读（双链新实例逐项 cast 核对，与旧栈一致）：vault=现行 Vault、
feeDistributor 沿用旧实例、governance=第 61 轮 Governance（Sepolia
0x1A25a086053703b41fec1Fa170A9BE3975afeCce / Base
0xc3b0ca3128ABAD6721d6C7F07D3129367d521e32）、chainConfig 沿用旧实例、
feeBps=1、meterKeepBps=7600、gasDeductCapBps=1000、
maxFailureGasChargeQuote=5e18、owner=deployer、relayer 未设（开放提交 B
模型）。双链 Vault.settlement() 已改指新实例；Vault lockers 仍仅 deployer。

仓库切换：frontend/src/config/chains.ts（+ chains.test.ts /
orderSigningTypes.test.ts 期望值）、relay/src/config.ts、indexer/config.yaml
（地址 + start_block=部署块）与 README/settlementAbi.ts 标识同步更新。MCP 骑
前端 chains.ts 单一事实源，无独立地址表需改；其硬断言测试
（mcp/test/config.test.ts、read-tools.test.ts）随后一并对齐第 62 轮栈。

**切换与冒烟结果（同日完成）**：
- 中继：D1 备份（78 orders + 2 pairs，仓外 bite100-relay-d1-backup-
  2026-11-10-r62.json）后重部署；线上无 CHAIN_CONFIG_JSON 覆盖，内置新配置
  生效；postman 轮换，新 npub npub1c8asdx0w7x30j0yru0j7tfq7q3qg45csgj2e-
  x4gsqxszhhze89uq7mn7gc；/health 正常。冒烟 4 张 maker 单经中继验签入库
  （新域口径实证）；补跑单投递收到 409——首轮同 (maker, nonce) 旧单仍在
  D1 live，块 D 在途撞号兜底按设计触发。
- Envio：新端点 f60e420（部署提交 e1f17df），_meta 双链 isReady 且
  startBlock 与部署块一致；VITE_INDEXER_URL 已切换、Pages 重跑后线上
  bundle 只含新端点与新 Settlement 地址。最终保留 2 台部署（e1f17df 现行
  + c32b430 兜底）。新端点 Trade 计数口径：只索引第 62 轮 Settlement，
  冒烟后为 3（即下述三笔结算）；旧栈 43 笔历史在兜底端点 210e3f4 完好。
- Sepolia 实盘冒烟（新栈 ETH/USDT）：乱序结算——先结 nonce 5
  （tx 0xefa8d8c32eb8c619c94a94c7bd2d8d33322d7034cba5856adf3ad3c72ed79913）
  再结 nonce 2（tx 0xf7d2f3d4a2a060b0499ad062c002f8e5d27a5d16b6b60f2f-
  cd453fa84a3ddedc），两笔 status 1 且 TradeSettled，位图核心验收通过；
  定点作废 invalidateUnorderedNonces(0, 1<<7)（tx 0xa7bbd65ab9fc7d0218d-
  3b614a5f4112b8cc4027f2f63a2f87831a460cba81715），作废后位图 word0=164
  （恰 bits {2,5,7}），该单结算 staticCall 以「nonce already used by
  another order」revert、真发 tx 0xb85213af89eace609db9d2cda8a8ec6a780f0-
  dd3f39d6f6ae131eeb566c2c35b 回执 status 0；相邻 nonce 6 随后正常结算
  （tx 0xdf308475149d4719e067529c39cfdcacd0fcce82e894c6db8ff797304b8d4272），
  终局位图 maker 228（bits {2,5,6,7}）/ taker 11（bits {0,1,3}）。

## 13. 审查与收尾（2026-11-10）

- ChatGPT 紧凑审查（区间 0c7d814..e213910）：**有条件通过**，1×P1
  + 4×P2。其核对确认：位图语义（bitmapPositions/XOR 消耗/OR 作
  废）与 Permit2 官方实现一致、Settlement 先验签后消耗不构成偏
  差、EIP-712 类型串与域构造未动、F1 删除评估（Merkle 入口可删、
  RelayerReputation 缓删）与 OZ 验签独立成轮的结论成立。
- 裁决：
  - **P1 部分成交点杀口径——部分成立**：机制是设计本意（调研期已
    定：点杀只管未开始订单，部分成交靠硬撤），但本文原 §1/§6 表
    述过度承诺，已同批修正（§6 口径修正段）；前端撤单的状态分流
    记为签名撤单后续轮验收项。
  - **P2 多标签页分配器竞态——成立**：同浏览器双标签页异步读改写
    可分配到同一 nonce，后果是其中一单被中继 409 拒绝或链上落败
    （可用性问题，非安全问题）。处置：Web Locks 协调 + 并发分配
    测试，列入下一轮（桥加固 + 气库）骑乘修复项。
  - **P2 中继唯一性边界——成立（表述层）**：409 只保证官方订单簿
    内不撞号，链上独占是最终防线；产品文案不得把 409 描述为全
    局防撞保证。以本节记录为准。
  - **P2 回滚非无损——成立**：回滚 runbook 补于下。
  - **P2 分配器 JS number 范围——不成立为缺陷**：全系统（中继以
    number 存储 nonce、前端 Number 转换）有意采用小序号顺序发号
    （调研硬约束），2^53 空间实际不可达；bigint 贯穿是另一场迁
    移，不在本轮范围。
- **回滚 runbook（Vault 改指回滚）**：① 停发新单（前端/中继下线
  新栈入口）；② 对新 Settlement 下仍有剩余锁定的订单，逐单走
  Vault 的 releaseOrderLock / releaseExpiredOrderLock 释放（该路
  径不经 Settlement，回滚期间可用，不困资）；③ 核对并导出新栈
  部分成交记录（orderFilled 存在新实例上，切回后旧实例不可见，
  须先留档）；④ Vault.setSettlement 改指回旧 Settlement 地址；
  ⑤ 前端/中继/索引器配置切回旧栈并回读验证。
- 主聊天独立复核：forge 223/223、新 Settlement 的 governance 与
  feeBps 回读、Vault 改指回读、乱序第二单结算回执 status 1、
  Envio 新端点 f60e420 双链 isReady 且 startBlock 与部署块一致。
  审查条件（P1 文档口径）已由本节同批修正消解；余两项 P2 一项入
  下一轮骑乘、一项为表述记录，runbook 已补齐。**第 62 轮关闭。**
