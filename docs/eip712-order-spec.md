# 比特100 订单签名规范（EIP-712）— 唯一规范

> 定版：2026-11-07（第二轮 P0-2）。本文件是订单签名的**唯一事实源**：前端
> （`frontend/src/services/orderSigningTypes.ts`）、Go 节点
> （`node/internal/match/signature.go`）、结算合约
> （`contracts/src/Settlement.sol`）三方必须与本文件逐字一致；改任何字段/域参数，
> 三方同步修改并更新跨语言测试向量。
>
> 背景：此前三方各有一套（前端/节点域 "比特100" 无 nonce 且域类型不一致——前端含
> verifyingContract、Go 不含；合约 `verifyOrderSignature` 域 "P2P Exchange" 含 nonce
> 却从未被调用；Go 派生 amountOut 时漏了 /1e18）。本规范一次性消除全部漂移。

## 1. 域分隔符（Domain）

类型字符串：`EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)`

| 字段 | 值 |
|---|---|
| name | `比特100`（UTF-8 字节，与三方源码中的字符串字面量一致） |
| version | `1` |
| chainId | 部署所在链（Sepolia = 11155111；本地 anvil = 31337） |
| verifyingContract | Settlement 合约地址（Sepolia = `0x9f0636839b6699d530F954F87B939DA6f56c9890`；Base Sepolia = `0x230887F48960E29066d9D3F593cB68F73Adccc85`；第 27 轮起，旧地址 Sepolia `0x549690D6…` / Base `0x6291E0F2…` 已取代） |

> **历史地址提示（第 34 轮注）**：本表及 §8 中的 Settlement 地址为**第 27 轮的历史地址**，仅用于说明域的构成与轮次演变，现行部署早已被后续轮次取代。**现行地址以最新轮次文档为准**（见 `docs/INDEX.md` 的现行部署记录；第 33 轮栈见 `docs/round33-hardening-2026-11-08.md`）。任何实现（前端/节点/中继/索引器）都不得从本文抄取地址，必须从当轮部署记录取值——中继就曾因内置了旧轮次地址导致验签失败（第 34 轮修复）。

合约侧在运行时以 `block.chainid` 与 `address(this)` 计算，天然绑定部署实例；
前端/节点侧由链配置提供（节点可用 `match.SetDomain` 覆盖，用于本地链）。

## 2. 订单结构（Order）

类型字符串（字段顺序即编码顺序，不得增删改序）：

```
Order(string orderId,address userAddress,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut,uint256 price,uint256 timestamp,uint256 expiresAt,uint256 nonce)
```

字段语义：

| 字段 | 语义 |
|---|---|
| orderId | 订单唯一 ID（前端 `generateOrderId` 生成） |
| userAddress | 签名者（下单用户）地址 |
| tokenIn / tokenOut | **交易对方向固定**：恒为该交易对的 (Token0, Token1)，与买卖方向无关（买卖由订单簿 side 字段表达，不进签名）。结算时以签名金额为上限做双向校验（见 §4），方向不影响资金安全 |
| amountIn | 愿以 tokenIn 支付/卖出的总量上限（最小单位整数） |
| amountOut | 愿换得的 tokenOut 总量（最小单位整数），必须满足 §3 公式 |
| price | 报价，1e18 定点缩放：`price = amountOut * 1e18 / amountIn` |
| timestamp | 下单时间（Unix 秒），不得晚于链上当前时间 |
| expiresAt | 过期时间（Unix 秒），必填；链上时间超过即不可结算 |
| nonce | 签名者的**链上结算 nonce**：下单时读取 `Settlement.getCurrentNonce(user)`；不是时间戳、不是消息去重 nonce（P2P 广播层的同名字段是另一概念，不得混用） |

字符串字段（orderId）按 EIP-712 规则以 `keccak256(bytes(value))` 进 structHash。

## 3. amountOut 派生公式（三方统一）

```
amountOut = amountIn * price / 1e18      （整数除法，向下取整）
```

前端下单时按此公式由用户输入的 amount 与 price 派生 amountOut；节点验签时按此
公式重算并比对；合约不重算公式（签名本身已绑死三个量），仅按 §4 做累计上限校验。

## 4. 结算校验（Settlement.Fill）

结算请求 `Fill` 携带 maker/taker 双方的完整签名订单（`SignedOrder{order, signature}`）
与实际成交量（tokenIn/tokenOut/amountIn/amountOut，方向以 maker 为准：
tokenIn = maker 卖出、tokenOut = taker 卖出）。合约逐项校验：

1. **验签**：对双方订单各算 EIP-712 digest，`ecrecover` 必须等于 `order.userAddress`。
2. **同对校验**：双方订单的 (tokenIn, tokenOut) 必须相同；Fill 的 tokenIn 必须是该
   对中的一侧，tokenOut 为另一侧。
3. **时效**：`timestamp <= block.timestamp <= expiresAt`。
4. **累计上限**：合约按订单 digest 记账 `orderFilledIn/orderFilledOut`（以订单自身
   方向计）。每笔成交按方向折算后累加，两侧都不得超过签名量。此规则同时支持
   部分成交（一单多笔结算）与防超额重放（全额成交后重复提交同一 Fill 必因超额
   被拒）。
5. **nonce 独占**：订单首次结算时经 `OrderNonceManager.useNonce` 消耗其 nonce
   （单调水位）；同一 digest 的后续部分成交跳过消耗；**不同订单复用同一 nonce
   永远无法结算**（其 digest 无成交记录且 nonce 已被占用 → 拒绝）。

批量入口（`settleTradesBatch` / `settleTradesBatchWithGasSavings` /
`settleTradesBatchWithMerkle`）与单笔走同一套 `_verifyFill` 校验，无例外路径。
Merkle 叶子 = `keccak256(abi.encodePacked(makerOrderDigest, takerOrderDigest,
tokenIn, tokenOut, amountIn, amountOut, gasReimburseIn, gasReimburseOut))`，
把签名订单内容绑进批次承诺。

## 5. 撤单签名（CancelOrder）

与订单共用同一域。类型字符串：
`CancelOrder(string orderId,address userAddress,uint256 timestamp)`。三方已对齐
（域类型同为四字段版）。

## 6. 跨语言测试向量

固定私钥/订单/域参数下，digest 与签名应在 Go、Solidity、TS 三侧一致。向量由
ethers 的 `TypedDataEncoder`（中立的 EIP-712 参考实现）生成，Go 测试
（`node/internal/match/signature_test.go` 的 `TestOrderDigestCrossLanguageVector`）
断言 Go 侧 digest 与签名恢复结果；合约侧由 anvil 端到端验证兜底（Go 签名的订单
必须能在真实部署的 Settlement 上结算成功，见 docs/anvil-e2e-verification.md）。

向量参数：chainId = 31337，verifyingContract =
`0x5FbDB2315678afecb367f032d93F642f64180aa3`，私钥 = anvil 账户 #0
（`0xac0974…ff80`，公开测试私钥），地址 `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`。

## 7. Gas 规则（第二十一轮，2026-11-07）

结算 gas 不由用户自备原生代币：中继代付后在结算层回收，规则如下（经济口径为产品定版，
实现细节与实测证据见 `docs/round21-gas-rules-2026-11-07.md`）。

### 7.1 成功结算：对半回收

- 每笔结算的 gas 成本由合约在链上计量：`gasUsed = (入口 gasleft 差值 + 内在成本
  21000 + 16×calldata 字节数 + 常量 85,000) × meterKeepBps / 10,000`（批量入口整批
  计量后按笔均摊）。`gasCostWei = gasUsed × tx.gasprice`（tx.gasprice 即回执的
  effectiveGasPrice，链上可核）。
- `meterKeepBps`（默认 7600）是净成本校准系数：gasleft 计量为 SSTORE 退款前毛值，
  提交者实付为退款后净值，系数把收费压回净成本附近且宁可少收不多收；治理可更新，
  主网部署前必须在主网分叉重新校准。
- 双方各承担 50%（ETH 计）：`halfWei = gasCostWei / 2`（奇数 1 wei 由协议吸收）。
  换算成各方**收到的资产**扣除：收到 quote 的一方按 ChainConfig 的
  `ethPriceInQuote` 换算直扣；收到 base 的一方再按该笔成交价（成交量比）换算。
  ChainConfig 未配参考价、或交易对两币均非 quote 时整笔不扣（事件 reason 标注）。
- 安全阀：单方扣除 ≤ 其该笔收到金额的 `gasDeductCapBps`（默认 1000 = 10%，硬顶
  50%），且不超过其 Vault 可用余额；差额（shortfall）由协议/提交者吸收，不转嫁。
  扣除经 Vault 转给结算提交者（msg.sender）。
- 每笔成交发射 `GasCostShared` 事件（gasUsed、gasCostWei、reason、双方扣除资产/
  金额/差额），前端与节点可逐笔对账。交易费（0.01%，FeeDistributor 99% / 开发者
  1%）与 gas 扣除是两条独立的账，互不混算。
- `Fill.gasReimburseIn/Out` 为旧版节点自报字段：保留在结构体中维持 ABI 兼容，
  结算路径**不再读取**（防自报套利），`maxGasReimbursePerTrade` 同步废弃。

### 7.2 失败结算：归责扣费

revert 的交易内无法扣款，失败扣费走独立入口 `chargeFailedSettlement(signedOrder,
reason, gasUsedClaimed)`，由结算调用方（owner/治理/白名单 relayer）在失败后申报：

- **归责只认两类链上可验事实**：`FAIL_ORDER_EXPIRED = 1`（订单 `expiresAt` 已过）、
  `FAIL_LOCK_RELEASED = 2`（订单锁已被释放/取消且该订单未成交完毕）。被扣方与被扣
  资产由 Vault 的**落锁墓碑**（`lockForOrder` 时写入、永不删除）决定，申报者无法
  指定或伪造；订单从未落锁则拒绝。
- 扣费额 = `min(gasUsedClaimed × 本笔 tx.gasprice × ethPriceInQuote, 
  maxFailureGasChargeQuote)`，再按订单签名价格换算成墓碑资产、按可用余额封顶。
  `maxFailureGasChargeQuote` 默认 0 = 功能关闭；同一订单只收一次
  （`failureCharged[digest]`）。
- `gasUsedClaimed` 无法链上核验（revert 回执不上链）——由硬上限与既有中继信誉
  机制约束申报者，节点侧只应以自己提交且 revert 的交易回执如实申报。
- 不可归责的失败不扣用户：撮合参数错误、重复提交已成交订单、提交者自身问题、
  参考价未配置、链/节点系统性故障——gas 由提交者自担。
- 存入/提取 Vault 的 gas 由用户自付，不在本规则内。

## 8. 合约用户与 ERC-1271（第二十七轮，2026-11-08）

订单的 `userAddress` 可以是合约（金库等），由注册签名者 EOA 代签。
三方校验规则（与 `contracts/src/Settlement.sol`、
`node/internal/match/signature.go`、`frontend/src/services/orderSigningTypes.ts`
逐字一致）：

- **签名域不变**：仍用 §1 的域（name `比特100`、version `1`、chainId、
  verifyingContract = 当前 Settlement 地址）。合约用户不改变域参数；
  Settlement 换地址时域随之切换（第 27 轮：Sepolia
  `0x9f063683…`、Base Sepolia `0x230887F4…`——均为历史地址，现行地址
  以最新轮次文档为准，见 §1 的历史地址提示）。
- **链上校验（Settlement.verifyOrderSignature）**：先走 EOA `ecrecover`
  快速路径；失败且 `userAddress` 有代码时，走 ERC-1271 回退——
  `SignatureChecker.isValidSignatureNow(userAddress, digest, signature)`
 （staticcall，失败 → false）。`_verifySignedOrder` 委托同一函数。注意：
  签名 `v` 值非法（如非 27/28）时 `_splitSignature` 会 revert 而非返回
  false（真实签名恒为 27/28；节点 eth_call 路径对此 fail-closed）。
- **合约侧（MakerVault.isValidSignature）**：仅当签名者已注册且未暂停时
  返回 magic `0x1626ba7e`，否则 `0xffffffff`；永不 revert。撤单 digest
  同样走 `isValidSignature`（CancelOrder 结构见 §5）。
- **节点 API 校验**：`POST /api/order` 与撤单先做纯 ecrecover 校验；
  失败且配置了 RPC 与 settlement 地址时，改走链上校验（10 秒超时；
  RPC 错误 → fail-closed 400）。纯校验通过的 EOA 订单不受影响。
- **nonce**：合约用户的 nonce 仍由 `Settlement.getCurrentNonce(userAddress)`
  读取，与 EOA 订单同一规则（§2）。注意：Settlement 换地址重部署后，
  `orderFilled`/`usedNonces` 从 0 起算（域绑定地址，digest 随之改变），
  旧订单/旧锁在新域下全部失效，须释放旧锁 → 按新域重签 → 重落锁。
- **安全边界**：ERC-1271 回退只认 `isValidSignature` 的返回值；金库合约
  的签名者注册表由 owner 控制，签名者只能交易、不能提款（见
  `docs/round27-maker-vault-2026-11-08.md` §1.1、§8）。
