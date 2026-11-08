# 阶段 3 价格校验修复（2026-11-08）

> 阶段 3 后端 ChatGPT 复审 P0 的修复轮。分支 `stage3-price-fix`（基线
> main 5b9e523）。状态：**本地完成，未 push、未部署**——新代码仍未上
> 任何链，测试网仍是第 33 轮栈，无实时暴露。本轮是测试网切换的硬
> 前置：合入并复审通过后，切换发令清单才可执行。

## 1. P0 原理与利用例

阶段 3 交审代码中，`Settlement` 的结算校验链为：`_verifyFill` 验签 /
方向 / 时效 / nonce，`_accountFill` 只查累计成交量不超签名量
（`newIn <= order.amountIn && newOut <= order.amountOut`）。**全合约
没有任何一处把成交比例与双方签名限价比较**——`order.price` 只在
`chargeFailedSettlement` 换算失败扣费时被读，结算路径从不读它。

利用例（复审原例，已逐行验码成立）：maker SELL 签 100 BASE ↔
200 QUOTE（签名限价 2 QUOTE/BASE），taker BUY 签 100 ↔ 200。开放
提交（模型 B）下任意地址构造 `Fill(amountIn=100, amountOut=1)`：
累计量 100 ≤ 100、1 ≤ 200 全部通过 → maker 交出 100 BASE 只收到
1 QUOTE，199 QUOTE 对价被无偿抽走。镜像地，对 BUY 方可在累计量
兼容时构造实付比例高于其签名上限的 Fill。

潜伏史：该缺口在第 33 轮栈即存在，当时结算提交受限（owner /
relayer），未被触发；阶段 3 开放提交后任何人可利用。因新代码尚未
部署任何链，本轮修复在暴露窗口打开之前完成。

## 2. 修复：不等式与落点

落点：`Settlement._accountFill` 在算出本笔切片（订单自身朝向的
`addIn / addOut`）之后、累计落账之前，调用新增内部函数
`_requireSignedLimitPrice(order, addIn, addOut)`。四个结算入口
（`settleTrade`、`settleTradesBatch`、`settleTradesBatchWithGasSavings`、
`settleTradesBatchWithMerkle`）全部经 `_verifyFill → _accountFill`
至此，无例外路径（GasSavings 非零路径在其自有循环里直接调用
`_verifyFill`，同样覆盖）。

不等式以**签名量本身**交叉相乘（`order.price` 语义即
amountOut/amountIn 的 1e18 定点，但比较不用它，见下）：

- SELL（付 tokenIn、收 tokenOut）：实收比例不得低于签名价
  `addOut * order.amountIn >= addIn * order.amountOut`
- BUY（付 tokenOut、收 tokenIn）：实付比例不得高于签名价
  `addOut * order.amountIn <= addIn * order.amountOut`

maker 与 taker 两张订单各自独立校验。口径要点：

- **为什么不用 `order.price` 比较**：`price` 是 amountOut/amountIn
  的截断商（如 3/7 → 428571428571428571），按它折算会把一侧的
  限价算偏、误杀恰在限价的合法成交。交叉相乘以签名量为准，
  等号精确放行，对 wei 级小额切片无舍入误差，全程无除法。
- **逐切片强制、非累计均价**：每笔部分成交独立满足限价——这是
  限价单语义本身，也防「先优后劣、均价达标」的切片攻击。
- **校验对象是 Fill 切片本身**：手续费与 gas 对半回收是成交额
  之外的独立扣项，不进不等式。
- **ABI 不变**：不改 Order/Fill 结构体与任何函数签名，九面
  （前端 / 节点 / 中继 / 索引器等）零影响，无需随行改版。
- **溢出方向安全**：Solidity 0.8 检查算术，乘积溢出即 revert
  （失败关闭）；结算路径金额受 uint128 上限约束，乘积稳在
  2^256 内。

## 3. 测试清单（forge 167 → 181，新增 14，全绿）

新文件 `contracts/test/Stage3PriceFix.t.sol`：

| 用例 | 锁死的语义 |
|---|---|
| test_SellLimitBreachedReverts | 复审利用例 100↔200 签、100↔1 提交：revert，双方资金不动 |
| test_BuyLimitBreachedReverts | 50↔150（3 B/A）击穿买方上限 2 B/A：由买方侧校验拦下（卖方侧与累计均兼容） |
| test_BatchBadPriceLegRevertsWholeBatch | 普通批：第二腿坏价格 → 整批回滚，合法腿不落账 |
| test_BatchWithGasSavingsBadLegRevertsWholeBatch | 骑乘：GasSavings 批入口坏腿整批回滚 |
| test_BatchWithMerkleBadLegRevertsWholeBatch | 骑乘：Merkle 批入口（证明先验过）坏腿整批回滚 |
| test_PartialFillExactlyAtLimitPasses | 恰在限价的部分成交 + 同价续结，两笔全过、逐切片等号放行 |
| test_PriceImprovementForTakerPasses | 双方限价 1 / 2 之间成交于 1.5：taker 价格改善、maker 亦优于下限 |
| test_MarketOrderWithinProtectionPasses | 市价单保护价 3 B/A 内以 2.5 B/A 成交通过 |
| test_MarketOrderProtectionBreachReverts | 同一市价单 3.2 B/A 击穿保护价：revert |
| test_TinySliceAtExactRatioPasses | wei 级切片 1↔2 恰为签名比例通过；同单 1↔1（比例不足）被拦 |
| test_TinyAmountsTruncatedPriceWouldMisKill | 签 7 付 3（price 截断）：交叉相乘等号放行，定点折算本会误杀的回归锁 |
| test_MakerVaultLegitPriceByStrangerPasses | MakerVault 买单（1271）签名价内由陌生人提交结算成功 |
| test_MakerVaultDeviatingPriceReverts | 同一金库单被以 3 B/A 偏离价提交：revert，金库资金不动 |
| test_FrozenDigestVector | 骑乘：冻结摘要 Solidity 侧断言（见 §4） |

基线 167 例在修复下**全绿**——存量诚实成交无一被新校验误伤，
总数只增不减。

## 4. 骑乘对照表

| 骑乘项 | 来源 | 落点 |
|---|---|---|
| 冻结摘要向量 Solidity 断言 | 同份复审 | `test_FrozenDigestVector`：`deployCodeTo` 把 Settlement 置于向量域地址 `0x5FbDB2315678afecb367f032d93F642f64180aa3`（chainId 31337），断言 SELL 摘要 `0xd793d795…e391cec0`、BUY 变体 `0x15842043…1b96` 与 ethers 向量签名验过。Go / Worker / Indexer / 前端四处已断言同一向量，Solidity 侧自此补齐为五方一致 |
| GasSavings / Merkle 两批入口坏腿回滚测试 | 同份复审 | §3 表中两例；连同普通批入口与单笔入口，四入口的坏腿拦截全员在册 |
| chargeFailedSettlement 计费口径入文档 | 同份复审 | §5（只记事实，不改代码） |

集成口径：修复只用 Solidity 0.8 检查算术与既有 `_accountFill`
映射，未引入新库 / 新组件；测试脚手架与 `Stage3.t.sol` 同构，
Merkle 树按既有 `MerkleProof` 排序对口径在测试内复算，向量值
取自 Go 测试的已冻结常量。

## 5. chargeFailedSettlement 计费口径（文档补记，不改代码）

逐行核对合约实现后的事实口径：

- **计价 gasprice 是申报交易自身的**：金额换算为
  `wantQuote = gasUsedClaimed × tx.gasprice × ethPriceInQuote / 1e18`，
  其中 `tx.gasprice` 是 `chargeFailedSettlement` 这笔申报上链
  交易的 gasprice。失败结算交易的回执不上链，其 gasprice 无从
  链上取得——口径即「reporter 用申报交易的 tx.gasprice 计价」。
- **`gasUsedClaimed` 为自报、链上不可验证**。限损靠三重：
  ① `maxFailureGasChargeQuote` 单笔硬上限封顶；② 同一订单
  digest 只收一次（`failureCharged`）；③ 申报角色受信门禁
  （见下）。被扣额另按墓碑资产与被扣方可用余额钳制。
- **默认关闭**：`maxFailureGasChargeQuote = 0` 时入口直接
  revert；主网初期保持默认关，启用须治理另行设定上限。
- **申报角色集合以代码为准**：`_isSettlementCaller()` =
  owner、单一 `relayer`（`setRelayer` 登记地址）、`isRelayer`
  白名单，**不含 governance**。`docs/eip712-order-spec.md`
  §7.2 旧文案「owner/治理/白名单 relayer」与代码不符，本轮已
  订正该处括注，以代码为准。

## 6. 提交清单

- `2b4f0be` 块 A：合约修复（`_requireSignedLimitPrice` + 落点 +
  注释口径同步）。
- `2947290` 块 B：`Stage3PriceFix.t.sol` 14 例。
- 块 C：本文档 + `docs/INDEX.md` 一行 + 阶段 3 轮文档 §8 完成
  标记 + `eip712-order-spec.md` §7.2 角色括注订正。

红线自查：未部署任何合约、未 push、未 merge、未重启任何服务、
未触碰运行中的 3A soak 及其代码路径；未使用任何密钥。
