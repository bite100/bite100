# 第二十一轮：gas 规则落进结算层（2026-11-07）

## 0. Ren 的规则（经济口径，本轮定版，不可改）

1. **对半回收**：中继代付的 gas 不是补贴。结算成功时，该笔结算交易的实际 gas 成本由
   maker 与 taker 各承担 50%，以各方在该笔成交中**收到的资产**扣除。
2. **失败算发起者**：可归责于一方的失败（订单无效、余额/锁定不足、过期等）所耗 gas
   由发起者承担；不可归责的系统性失败不扣用户。
3. 交易费不变：0.01%（feeBps=1），FeeDistributor 99% / 开发者 1%。gas 扣除与交易费
   是两条独立的账。

## 1. 动手前核实（以代码为准）

- **旧机制存在但形同虚设**：`Fill.gasReimburseIn/Out` 是节点**自报**的金额，旧
  `_settleOne` 原样按自报值从双方收到额中转给 `msg.sender`；唯一约束
  `maxGasReimbursePerTrade` 默认 0 = 不限额。无链上计量、无强制对半、无失败扣费。
  自报口径与「实际 gas 成本」无关且可套利，本轮废弃其效力（字段保留维持 ABI 兼容）。
- **节点结算路径**：`node/internal/settlement/submit.go` 只提交**单笔** `settleTrade`
  （无批量调用），`gasReimburse` 恒填 0/0，无预检/模拟——链上失败即 revert，gas 由
  提交者（中继）自吞。今天没有任何一方为失败付费，也没有对半回收在发生。
- **Vault**：`transferWithinVault`/`transferOut` 仅 Settlement 可调；可用余额 =
  余额 − 挂单锁定；未落锁的订单无法结算（`consumeOrderLock` 无记录即 revert）——
  这意味着「曾落锁」是链上可查的事实，可作归责凭据（见 §3 的墓碑设计）。
- **FeeDistributor**：`developerShareBps` 默认 100（1%），`receiveFee` 时自动转给
  开发者地址；其余累积待分配。本轮不改。
- **ChainConfig** 原有链注册/治理结构，无价格字段；系统内无预言机。

## 2. 对半回收设计

### 2.1 计量

```
gasUsed(计量) = 入口 gasleft() 差值 + 内在成本(21000 + 16 × calldata 字节) + 85,000(常量)
gasUsed(收费) = gasUsed(计量) × meterKeepBps / 10,000
gasCostWei    = gasUsed(收费) × tx.gasprice
```

- 计量点在结算执行之后、扣款执行之前；常量 85,000 覆盖扣款段（两笔划转 + 事件）
  的不可测尾部。
- **净成本校准（关键修正）**：`gasleft()` 计的是 SSTORE 退款**前**的毛 gas，而提交者
  实付是退款**后**净值（回执 gasUsed）。anvil 实测（2026-11-07，脚本
  `contracts/script/CalibrateGas.s.sol`）：全量成交（删两条锁记录）毛计量 704,117
  vs 净回执 532,047（+32.3%）；部分成交 682,057 vs 557,987（+22.2%）。若按毛值
  收费将系统性多收用户两到三成，违背「实际 gas 成本」。故引入校准系数
  `meterKeepBps`（默认 **7600**，治理可调）：两点拟合误差 **+0.6% / −7.1%**。
  校准后复验（全量）：收费 535,108 vs 净 532,248（**+0.54%**）。校准纪律：误差宁可
  偏向少收（差额协议吸收），不许系统性多收。事件中 `tx.gasprice` 与回执
  effectiveGasPrice 逐一吻合（计价基准正确）。
- 批量入口（Batch / BatchWithGasSavings / BatchWithMerkle）：整批计量后**按笔均摊**
  ——同一批的提交成本本就不可逐笔拆分，均摊是唯一无任意性的口径；逐笔事件
  `gasUsed` 相同。

### 2.2 换算与扣除

- `halfWei = gasCostWei / 2`，双方 ETH 份额恰好各半（奇数 1 wei 协议吸收）。
- ETH→quote：ChainConfig 新增 `quoteToken` + `ethPriceInQuote`（owner/治理可更新，
  部署读回核实）。测试网由部署者设 2000（占位参考价）。
- quote→base：按**该笔成交价**换算（`want = halfQuote × 对侧成交量 / 本侧成交量`），
  与订单签名价格口径一致，不需要第二个价格源。
- 收到 quote 的一方直扣 quote；收到 base 的一方扣换算后的 base。从双方 Vault
  余额经 `transferOut` 转给结算提交者（msg.sender），与旧机制的收款方一致（中继
  垫付、向中继回收）。
- 跳过分支（事件 reason 标注、整笔不扣）：参考价未配置（=1 GAS_SHARE_NO_PRICE）；
  交易对两币均非 quote（=2 GAS_SHARE_NOT_QUOTED）——没有可信换算路径时宁可不扣，
  不许瞎扣。

### 2.3 安全阀

- 单方扣除 ≤ 其该笔收到金额的 `gasDeductCapBps`（默认 **1000 = 10%**，硬顶 50%）：
  小额成交遇到 gas 尖峰时，用户最多损失收到额的一成；且扣除不超过其 Vault 可用
  余额（刚收到的资产就在账上，通常足够）。
- 超出部分记为 shortfall 写进事件，**协议/提交者吸收**——中继少回收，不向用户
  追扣、不挂账到下一笔。

### 2.4 事件与对账

每笔成交发射 `GasCostShared(maker, taker, gasRecipient, gasUsed, gasCostWei,
reason, makerToken, makerDeduct, makerShortfall, takerToken, takerDeduct,
takerShortfall)`。交易费仍走原 `receiveFee` 流（Vault→Settlement→FeeDistributor，
开发者 1% 自动到账），与 gas 扣除在链上是不同的资金流，逐笔可分开核对（E2E 已验）。

## 3. 失败扣费设计

### 3.1 执行点比较（为什么选申报制）

| 方案 | 评估 |
|---|---|
| 批量结算逐笔 try/catch 捕获失败当场扣 | 批量入口当前是整批原子语义，改逐笔捕获会破坏原子性；且 revert 原因在 catch 点无法区分归责方（哪侧订单、什么原因），链上信息不足。**不选** |
| 用户预存 gas 押金/托管池，失败从押金扣 | 给每个用户加一笔常驻押金与退还流程，与第十七轮后「把 Vault 存入做顺滑」的方向冲突，摩擦大。**不选** |
| **节点事后申报 + 合约验事实（选定）** | 失败交易的回执在节点手里（gasUsed 可知）；合约只验**链上事实**（订单是否落过锁、是否过期、锁是否已释放），被扣方/资产由合约从落锁记录推导，申报者不可伪造。与现有「节点提交、合约校验」的分工一致 |

### 3.2 选定实现：`chargeFailedSettlement`

- Vault 新增**落锁墓碑** `lockTombstones[digest] = {user, token}`：在 `lockForOrder`
  时写入、永不删除（活动锁记录在释放/消耗时删除，无法事后证明「曾落锁」——墓碑
  专为归责留证；被扣方 = 墓碑 user，被扣资产 = 墓碑 token，即该订单当时锁定的
  付出资产，申报者无从指定）。
- 合约校验的归责类别（reason）只有两类，均为链上可验事实：
  - `FAIL_ORDER_EXPIRED = 1`：订单 `expiresAt < block.timestamp`（订单字段自带，
    签名覆盖，不可篡改）；
  - `FAIL_LOCK_RELEASED = 2`：活动锁已不存在 **且** 该订单在墓碑资产侧未成交
    完毕（锁耗尽 ⟺ 成交完毕，故「未成交完 + 无活动锁」⟹ 锁被释放/取消）。
- 金额：`min(gasUsedClaimed × 本笔 tx.gasprice × ethPriceInQuote,
  maxFailureGasChargeQuote)`，按订单签名 `price` 换算到墓碑资产，再按可用余额
  封顶。`maxFailureGasChargeQuote` 默认 **0 = 功能关闭**；本轮测试网部署设 5e18
  （5 个 quote 单位）以便 E2E 与后续试运行——开启与额度都是治理决策。
- 防重复：`failureCharged[digest]` 一单只收一次。事件 `FailedSettlementCharged`。
- 调用方：既有 `_isSettlementCaller`（owner / 治理 / 白名单 relayer）。
- 节点侧：`node/internal/settlement` 新增 `ChargeFailedSettlement` 申报入口
  （含原因常量与 ABI 打包单测）。**默认不在撮合主路径自动调用**——节点运营者
  应只对自己提交且 revert 的交易、拿回执 gasUsed 如实申报；是否自动申报是运营
  策略决策，不在本轮代码里写死。

### 3.3 归责表

| 失败情形 | 承担方 | 本轮覆盖 |
|---|---|---|
| 订单已过期仍被提交结算 | 订单方（过期方） | ✅ FAIL_ORDER_EXPIRED |
| 用户撤单/释放锁定后，节点在途结算到达 | 撤单方 | ✅ FAIL_LOCK_RELEASED |
| 订单从未落锁（节点没锁就提交） | 提交者（节点流程错误） | ❌ 不扣用户（无墓碑直接拒绝申报） |
| 累计成交超额（重复提交已成交订单） | 提交者（节点应查已成交量） | ❌ 不扣用户 |
| 验签失败/订单被篡改 | 提交者（撮合层应拦截） | ❌ 不扣用户 |
| 余额不足导致锁定失败 | ——（锁定在节点接单环节，未上链，无 gas 消耗于结算） | 不适用 |
| 参考价未配置、链拥堵、RPC/节点故障等系统性失败 | 提交者/协议 | ❌ 不扣用户 |
| 申报 tx.gasprice 波动 | 申报额按申报 tx 自身 gasprice 换算并有硬上限 | 已封顶 |

### 3.4 诚实声明：gasUsedClaimed 不可链上验

revert 交易的回执不上链，合约无法核验申报的 gasUsed 是否属实。约束只有两道：
单笔硬上限（`maxFailureGasChargeQuote`）与既有中继信誉机制（违规记录/信誉分）。
因此失败扣费默认关闭，启用时应同时把上限设为「一笔结算失败的合理 gas 成本」
量级（如测试网的 5 quote），使虚报的收益空间被压到最小。此为已知限制，不假装
已解决；主网启用前应再评估（如要求申报附带回执的默克尔证明等重方案，暂不做）。

## 4. 部署（2026-11-07，双测试网）

部署脚本 `contracts/script/DeployGasRules.s.sol`（ChainGuard 校验目标链），只换
Vault + Settlement + ChainConfig 三个受影响合约；FeeDistributor / Governance /
TokenRegistry / ContributorReward / 代币 / 桥全部复用既有实例（桥绑定代币地址，
与 Vault/Settlement 无关）。

| 链 | Vault（新） | Settlement（新） | ChainConfig（新） |
|---|---|---|---|
| Sepolia | `0xF9695C43bEBA0aB43e4Bef206DCd6C40480bE9f5` | `0x549690D6bb9f1b5dB072A8E3fd3A4060e55B7Ef6` | `0x52De0F096B169f612E55084eE05Efa7D1dEaa0c4` |
| Base Sepolia | `0x46592e98ea76D8d1e987b69194b74828A91E3D50` | `0x6291E0F2da9754ca933CcDc8D013184A7cE63671` | `0x41b12b6620750564a412b294a1a2bBde24a3B9E8` |

配置：quoteToken = TKB（各链既有）、ethPriceInQuote = 2000e18（测试占位）、
maxFailureGasChargeQuote = 5e18、gasDeductCapBps = 1000、meterKeepBps = 7600、
Vault.locker = 部署者、Settlement/ChainConfig 的 governance = 既有 Governance。

读回核实（双链全过）：Vault.settlement 指向新 Settlement；Settlement.feeDistributor
= 既有 FD 且 **FD.developerAddress = Ren 钱包、developerShareBps = 100（1%）未
回归**；Settlement.chainConfig 与 ChainConfig 的 quoteToken/ethPriceInQuote/
governance 均与上表一致。

部署花费：Sepolia ≈ 0.000140 ETH、Base Sepolia ≈ 0.0000413 ETH。部署后余额：
Sepolia ≈ 0.04962 ETH、Base Sepolia ≈ 0.009656 ETH（E2E 后见 §5 末）。

## 5. E2E 证据（双链实测，脚本 `contracts/script/E2EGasRules.s.sol`）

场景：maker 卖 100 TKA、taker 卖 100 TKB，成交价 1:1，双方各预存 500。

### 5.1 正常结算（逐 wei 核对，核对脚本独立复算）

**Sepolia**（结算 tx `0xb2926c9f…c2ef9`）：
- 回执 gasUsed 1,451,097（publicnode 的非标准计量口径，见 §7 注）、
  effectiveGasPrice 3,000,000 wei；事件 gasUsed（收费）1,248,308、
  gasCostWei 3,744,924,000,000 == 收费 gasUsed × effectiveGasPrice ✔
- makerDeduct == takerDeduct == **3,744,924,000,000,000**（= gasCostWei/2 × 2000，
  恰好各半，逐 wei 相等），shortfall 均为 0
- 到账：maker 的 TKB = taker 的 TKA = 99.99e18 − halfQuote ✔
- 费用分账（本 tx Transfer 流水）：每侧手续费 0.01e18 走 Vault→Settlement→FD，
  FD→Ren **0.0001e18**（1%）✔；gas 扣除 Vault→提交者 每侧 halfQuote，与手续费
  两条线分开 ✔（15 项断言全过）

**Base Sepolia**（结算 tx `0x1b02e08f…cb4d`）：
- 回执 gasUsed 491,545、effectiveGasPrice 6,000,000 wei；事件收费 gasUsed
  498,454（与回执偏差 **+1.41%**，标准计量链上校准成立）、gasCostWei
  2,990,724,000,000 ✔
- makerDeduct == takerDeduct == **2,990,724,000,000,000**（逐 wei 各半），
  shortfall 0；到账与费用分账同上全过（15 项断言全过）

### 5.2 可归责失败（订单过期）

流程：预锁一笔短时过期的 maker 订单 → 到期后真实提交结算（链上 revert，
原因 `Settlement: order expired`，由 RPC 估算报错与回执双证）→ 节点以**该 revert
交易回执的真实 gasUsed** 申报 `chargeFailedSettlement(reason=1)`。

**Sepolia**：结算尝试 tx `0x798f42a9…a170`（status 0，gasUsed 107,416 @
3,000,000 wei）；扣费 tx `0xd627dd3e…0fd8`（status 1）。事件
`FailedSettlementCharged`：chargedUser = maker、token = TKA（墓碑资产）、
amount = **644,496,000,000,000** == 107,416 × 3,000,000 × 2000（逐 wei）；
maker 的 TKA Vault 余额精确减少该额，taker 余额分毫未动（11 项断言全过）。

**Base Sepolia**：结算尝试 tx `0x3fcab284…0327`（status 0，gasUsed 56,677）；
扣费 tx `0x95bc89d0…5bed`（status 1，effectiveGasPrice 6,000,000 wei）。
amount = **680,124,000,000,000** == 56,677 × 6,000,000 × 2000（逐 wei）；
maker 被扣、taker 未动（11 项断言全过）。

执行注记（工具链实测，如实记录）：① 第一笔预锁曾用 90 秒保险丝，低 gas 价下
锁定 tx 落链超时导致 lock 本身 revert——改为 900 秒并加 MODE=3 补锁后完成；
② forge script 的 broadcast 模拟 EVM 中 `tx.gasprice` 恒为 0，依赖 gasprice 的
扣费逻辑在模拟期必然误判 revert（`vm.txGasPrice` 在 broadcast 收集模式下不
传递）——结算尝试与扣费申报因此改用 cast send 发真实交易，脚本只负责签名
（MODE=6）。合约逻辑本身经 forge 单测（`vm.txGasPrice(1 gwei)`）与上述真实
交易双重验证，不受该工具链限制影响。

E2E 总花费（部署 + 全部 E2E 交易）：部署者 Sepolia 0.0497642 → 0.0496107 ETH
（合计约 0.0001534，其中部署约 0.000140）；Base Sepolia 0.0096973 → 0.0096477
ETH（合计约 0.0000496，其中部署约 0.0000413）。

## 6. 前端

- `chains.ts`：双链 vault/settlement/chainConfig 更新为本轮新地址（构建产物已验
  含新 Settlement 双链地址、无旧地址残留）；`chains.test.ts` 同步更新断言。
- **顺手修复的已知缺陷**：`FeeDisplay` 写死的「节点 20% / 开发者 30% / 流动性
  50%」与链上真实口径矛盾（该组数字无任何链上依据）。改为真实口径：交易费
  0.01%；手续费分成 = 开发者 **1%**（成交时自动到账）/ 贡献者分配池 **99%**
  （按治理权重定期分配）。`OrderBookSection` 调用点同步删除假数字传参。
- gas 分摊展示：FeeDisplay 的 Gas 行文案补明「你承担的一半以你收到的资产扣除」；
  新增「费用说明」段（对半口径、10% 上限、到账公式、失败归责、存取自付）；
  下单表单在总额行下新增「费用提示」、限价单说明段补齐 gas 口径（中继代付、
  双方对半、以收到资产扣除、10% 上限、过期/撤单失败自担）。全站文案不出现
  「免 gas」字样，口径与第十四轮一致。

## 7. 门禁与注记

- forge：**119/119 全绿**（基线 108；净增 11：GasRules 专项 11 例，旧自报口径
  3 例改写为 2 例，ChainConfig 参考价 1 例）。
- Go：`go test` 除 `cmd/reputation-updater` 外全绿（含新增
  `TestPackFailureCharge`）。注：`cmd/reputation-updater` 在 HEAD 上即有编译
  错误（未用变量的桩程序，与本轮无关、本轮未动），如实记录待后续处理。
- npm：**116/116 全绿**；`npm run build` 成功且产物含双链新 Settlement 地址。
- 注：Sepolia 经常用 RPC（publicnode）的 gas 计量为非标准口径（第十五轮已记），
  本轮其回执 gasUsed（1,451,097）与合约收费 gasUsed（1,248,308）偏差 −14%——
  方向为**少收**（用户有利、提交者少回收），与校准纪律一致；标准计量链
  （anvil / Base Sepolia）偏差在 +0.5%～+1.4%。

## 8. 已知限制与主网门禁

1. **主网价格来源（门禁）**：ETH→quote 参考价主网必须改为可信来源（如 Chainlink
   ETH/USD 喂价 + quote/USD 组合，或治理多签定期更新 + 偏差熔断），不许沿用
   测试网的人工设定值上线。本轮只把字段与更新权限备好。
2. **meterKeepBps 主网校准（门禁）**：7600 是 anvil + 测试网校准值；主网部署前
   必须在主网分叉按真实合约组合（真实 ERC20、真实锁单流）重新校准并读回。
3. **失败扣费默认关闭**：`maxFailureGasChargeQuote` 主网初始应为 0；启用需治理
   决策 + 合理上限 + 节点申报规范（§3.4 的不可验声明）。
4. **gasUsedClaimed 不可验**：见 §3.4。
5. **批量均摊的近似性**：批量内各笔按均摊计费，单笔真实边际成本有差异；安全阀
   保证单方最坏损失 ≤ 收到额 10%。
6. **Vault 换新 = 用户需迁移余额**：本轮 Vault 为新实例，旧 Vault 的用户余额不
   自动迁移（测试网无真实用户；主网若将来换 Vault 需迁移方案，不在本轮）。
7. locker 仍为部署者单地址（与第十五轮口径一致）；主网应切换为 leader/BFT
   中继集合（第十五轮已记的门禁，不变）。
