# 第二十七轮：做市金库（Tier 2）— 2026-11-08

> 目标：合约金库 + 链上注册的授权签名者（签名者只能交易、不能提款），份额记账用
> OpenZeppelin ERC-4626 标准组件；金库签名者下的订单走线上节点撮合与第 26 轮已
> 接通的结算提交路径；双链各一笔真实交易 E2E。
>
> 本轮同时修复两处第 26 轮验收遗留的超时误判缺陷（§5）。
>
> 设计稿：`docs/market-maker-vault-design.md`（Tier 2）。

## 0. 摘要与关键决策

**结果**：全部达成。MakerVault + 新 Settlement 部署到 Sepolia 与 Base Sepolia
并链上核实；节点已迁移到新 Settlement 并重启；双链 E2E 各一笔真实交易结算
成功（金库买入 0.01 BTC / 0.01 ETH），NAV 与份额链上可读；另有一笔 EOA 对 EOA
回归交易在新 Settlement 上结算成功；forge 131/131、go 全绿、anvil 4/4、
npm 169/169 + 构建通过。

**本轮最关键的架构决策（#1 待主聊天/Ren 复核，见 §9）**：

`Settlement.verifyOrderSignature` / `_verifySignedOrder` 原本只做
`ecrecover(digest) == order.userAddress`——**不支持 ERC-1271**。金库合约作为
`userAddress` 持有交易 Vault 余额、由注册签名者 EOA 代签时，结算层必须认
合约签名，否则"签名者只能交易、不能提款"的 Tier 2 核心属性无法成立（若改
为签名者 EOA 本人当交易用户，提款就只能靠操作约定，合约不强制）。

因此本轮**重新部署了 Settlement**（加 ERC-1271 回退），并把交易 Vault 的
`settlement` 指针、节点配置与前端 EIP-712 域全部切到新地址。旧 Settlement
（Sepolia `0x549690D6…` / Base `0x6291E0F2…`）在测试网已被取代，见 §2。

迁移前已确认安全：节点数据库无 pending / retrying / submitting 状态的交易
（Sepolia 仅 2 笔 failed，均为第 26 轮 E2E 的 terminal 失败；Base 全部
settled），因此新 Settlement 的空 `orderFilled` 状态不会重复结算任何已
成交订单。部分成交的开放订单：未来按剩余量成交是安全的；但旧的全量
fill 若被过期重提交，新 Settlement 无法从链上识别已成交部分——切入时
零待结算交易是本次迁移的前提，见 §9。

## 1. 合约改动

### 1.1 `contracts/src/MakerVault.sol`（新增）

ERC-4626（OpenZeppelin 标准组件）+ Ownable + Pausable + ReentrancyGuard +
IERC1271。资产 = USDT（18 位 mock），base 代币与 Chainlink feed 由构造参数指定。

- **存款即入仓**：`_deposit` 把 USDT 自动转入交易 Vault（构造时对交易 Vault
  设 max approval，仅交易 Vault 一个 spender）；份额按 ERC-4626 标准会计，
  存款人承担盈亏（HLP 模型），PnL 沉淀在 NAV 里。
- **取款**：`_withdraw` 从交易 Vault 拉回不足部分；**被订单锁定的库存不可取**
  ——有锁仓时 redeem 会 revert，直到订单取消/过期释放。取款不经过签名者，
  签名者无权动存款。
- **NAV 定价**：`totalAssets()` = 交易 Vault 内余额（USDT + base × Chainlink
  价）+ 合约直接持仓；base == 0 时跳过价格查询；base > 0 且 feed 过期时
  revert（fail-closed，不报假价）。过期阈值 `PRICE_STALE_AFTER = 10800`
  秒（心跳 ×3，第 23 轮规则）。
- **签名者注册表（未来角色载体）**：`authorizedSigners`、
  `signerRoles`、`setSigner(address, bytes32, bool)`（仅 owner）。角色常量
  `ROLE_MARKET_MAKER` / `ROLE_SETTLEMENT_SUBMITTER` / `ROLE_RELAYER`——
  注册表是未来 settlement submitter / nodeless relayer 的准入表，签名者
  没有被写死成只能做市。本轮只注册了 `ROLE_MARKET_MAKER`。
- **ERC-1271**：`isValidSignature` 用 `ECDSA.tryRecoverCalldata`，返回
  `0x1626ba7e` / `0xffffffff`，永不 revert；暂停时签名失败。
- **暂停语义**：`pause()` / `unpause()` 仅 owner；暂停 блокирует 存款与订单
  签名，**不 блокирует 取款与签名者轮换**。
- **无 owner 提款函数**：owner 只能通过持有份额赎回，不存在绕过份额的
  提取路径（测试覆盖）。
- 构造参数：`(IERC20 asset_, address tradingVault_, address baseToken_,
  address priceFeed_)`——MakerVault **不存 settlement 地址**（`isValidSignature`
  与调用方无关；交易 Vault 持有 settlement 指针）。

### 1.2 `contracts/src/Settlement.sol`（修改）

引入 OpenZeppelin `SignatureChecker`；`verifyOrderSignature` 保留 EOA
`ecrecover` 快速路径，`userAddress` 有代码时加 ERC-1271 回退
（`SignatureChecker.isValidSignatureNow`，staticcall，失败 → false）；
`_verifySignedOrder` 改为委托 `verifyOrderSignature`（去重）。Fill ABI
不变，EOA 订单路径零改动。

### 1.3 `contracts/src/mock/MockAggregatorV3.sol`（新增，仅测试）

可设价格/更新时间，8 位小数，供 MakerVault 测试用。

### 1.4 构建配置变更（仓库级，需记录）

`foundry.toml` 的 solc 从 `0.8.20` 升到 **`0.8.24`**，并加
`evm_version = "cancun"`：OZ 5.6.1 的 ERC4626 / SignatureChecker 要求
`^0.8.24`。0.8.30 与 0.8.28 均在 via_ir 下报 Yul stack-too-deep
（Settlement `_settleOne`，"Variable _2 is 1 too deep in the stack"，
无文件/行号指针）；**0.8.24 编译通过**。此后不要无故改动 pinned solc，
改动须在本轮文档留档。

测试：`contracts/test/MakerVault.t.sol`（新增，12 个测试）——存款转发与
NAV、base 定价（0.01 BTC × $75,822.34 → NAV 1758.2234e18）、取款拉回、
锁仓 блокирует 取款、ERC-1271 金库买单链上结算、完整往返（第二腿卖出
扣费后的 0.009999 BTC）、签名者轮换/撤销、`isValidSignature` 直调、
暂停语义、过期 feed fail-closed（base == 0 豁免）、owner 无份额不能提款。
两处测试期修正：`convertToAssets` 期望放宽到 ±1 wei（OZ 虚拟份额 +1
偏移）；第一腿 Fill 的 maker/taker 归属以卖出 tokenIn（BTC）的一方为准。

## 2. 地址表（测试网，2026-11-08）

| | Sepolia (11155111) | Base Sepolia (84532) |
|---|---|---|
| **Settlement（新，本轮）** | `0x9f0636839b6699d530F954F87B939DA6f56c9890` | `0x230887F48960E29066d9D3F593cB68F73Adccc85` |
| **MakerVault（新，本轮）** | `0xEFD02ae9E90C6d515299953A41c4788F2FceC09f` | `0x73B55e2d41CA5A765ac982036d4b8C5E25ae877A` |
| 金库交易对 | BTC/USDT | ETH/USDT |
| 金库资产 / base | USDT `0x6Ca8cb68…` / BTC `0x8EDa0025…` | USDT `0xaab464e0…` / ETH `0x151c6be0…` |
| Chainlink feed | BTC/USD `0x1b44F351…` | ETH/USD `0x4aDC6769…` |
| 交易 Vault（不变） | `0xF9695C43…E9f5` | `0x46592e98…3D50` |
| 旧 Settlement（已取代） | `0x549690D6…7Ef6` | `0x6291E0F2…3671` |
| 金库签名者（双链同地址） | `0x05040D9ec117A264C58B293Feed7aB40A9B5A726`（角色 `ROLE_MARKET_MAKER`） |

签名者私钥只存于 `~/workspace/bite100-deployer/vault-signer.env`（600 权限），
与部署者钱包同一惯例，绝不进仓库、不打印。部署者
`0x4B3fbb64ed7F3CD892484154EC684C1eFC8fa93e`。

新 Settlement 链上配置（双链一致，已逐项读回核实）：governance 与旧值
相同（Sepolia `0x31900dD9…` / Base `0x26b60846…`），chainConfig
（Sepolia `0x52De0F09…` / Base `0x41b12b66…`），feeDistributor
（Sepolia `0x346DE29B…` / Base `0xAeC85272…`），feeBps 1（0.01%），
meterKeepBps 7600，gasDeductCapBps 1000，maxFailureGasChargeQuote 5e18，
owner = 部署者；`Vault.settlement()` 已指向新 Settlement；MakerVault
owner / asset / tradingVault / baseToken / priceFeed 全部读回正确；
签名者 authorized = true，role = `keccak256("MARKET_MAKER")`。

## 3. 部署证据

部署脚本：`contracts/script/DeployMakerVault.s.sol`（ChainGuard 模式）——
链上读取旧 Settlement 配置（governance / chainConfig / meterKeepBps /
gasDeductCapBps / maxFailureGasChargeQuote）→ 部署新 Settlement →
复制配置（feeBps 默认 1）→ `Vault.setSettlement(new)` → 部署
MakerVault → `setSigner(signer, ROLE_MARKET_MAKER, true)`。

### 3.1 Sepolia（曲折，两次 broadcast 拼成最终状态）

- 第 1 次（`--gas-price 50000000`）：forge 未把该值用作 EIP-1559 max fee
  （估算 0.525 gwei），Settlement 部署因 "insufficient funds for gas ×
  price + value: have 0.02104 ETH want 0.02282 ETH" 失败（gas limit
  ~43.3M × 0.525 gwei）。
- `--resume`：沿用旧费率再次失败；但其余 8 笔交易（nonce 209–216）已发出并上链。
- `--start-fresh`（`--with-gas-price 50000000 --priority-gas-price 1000000`）：
  Settlement 部署（nonce 208）上链后，forge 重试同 nonce 交易报
  "replacement transaction underpriced / nonce too low" 而中止；其余
  交易因 nonce 已被 `--resume` 的交易占用而未发出（MakerVault 两笔 hash
  为 None）。
- **最终状态：9 笔交易全部上链，部署者 nonce 208–216**，无 pending 交易。
  部署者余额 0.02104 → 0.01207 ETH（部署花费 0.00897 ETH）。

| 步骤 | tx | gasUsed | 状态 |
|---|---|---|---|
| Settlement 部署 | `0x0485c4286c1e610decfc64594245dc2de55312c1bc47a3a7ff7b4c3bd7bfb48a` | 33,430,804 | 成功 |
| setGovernance | `0x4591c1ed12f2954b7b3970eb3a8b1da9009ded1009c356be83496da7af407cf1` | 130,124 | 成功 |
| setChainConfig | `0x865327a9681f392a96c3b852cc5b0fe8a7fa871e186f36ceb48a51c218897363` | 32,789 | 成功 |
| setMeterKeepBps / setGasDeductCapBps / setMaxFailureGasChargeQuote | 链上读回值已核实（7600 / 1000 / 5e18） | — | 成功 |
| Vault.setSettlement | `0xe5316ac2687e1b40eef57150ccee2cf29958169dad8d358d60e7988e2c1da062` | 31,855 | 成功 |
| MakerVault 部署 | `0x83862f53776c0b4e9354c654922e612a851e2a6809eef807317ecc15d6e8d0d3` | 16,407,186 | 成功 |
| setSigner | `0x22bc6ac485634636d5f75a408fd53b23aee12699aceddca9fc6004918690293e` | 241,224 | 成功 |

broadcast 文件：
`contracts/broadcast/DeployMakerVault.s.sol/11155111/`（run-1794072839558.json
= resume，run-1794072939924.json = start-fresh）。

### 3.2 Base Sepolia（干净，单次 broadcast）

"ONCHAIN EXECUTION COMPLETE & SUCCESSFUL"。部署者余额 0.00961 →
0.00957 ETH（花费 0.000045 ETH）。

| 步骤 | tx | gasUsed | 状态 |
|---|---|---|---|
| Settlement 部署 | `0x9babcb0a9052407ce3df5f02823842e4efa0ba2e8088716197c575afc94629c4` | 4,771,170 | 成功 |
| MakerVault 部署 | `0x55160b29a54fcf6bc2aafe58392a1329e829fa81232fe8427e4f589285756923` | 2,385,154 | 成功 |
| 其余配置调用 | `0x851c293e…` / `0x3f6801b2…` / `0xa618a151…` / `0x33851bba…` / `0xef5b4a96…` / `0x70747b8c…` / `0x7a68b7f5…` | — | 成功 |

broadcast 文件：`contracts/broadcast/DeployMakerVault.s.sol/84532/run-latest.json`。

### 3.3 Sepolia ~7× gas 计量（已核实，沿用第 21/25 轮结论）

同一 Settlement 部署：anvil 4,771,170 gas、Base Sepolia 4,758,114 gas、
Sepolia 回执 33,336,612–33,430,804 gas；MockERC20 BTC 部署：Sepolia
3,551,789 vs Base 565,635（~6.3×）。实操：用宽 gas limit（forge 经 RPC
估算）+ 低 gas price（Sepolia `--with-gas-price 50000000
--priority-gas-price 1000000`），绝对成本仍小（Sepolia gas 价约
0.003–0.05 gwei）。本轮 E2E 的 Sepolia 结算回执 gasUsed 1,322,687 即为
7× 计量值，真实约 190k。

**部署者余额（本轮结束时）**：Sepolia **0.01163 ETH**，Base **0.00956 ETH**
（含 E2E 结算提交者 gas）。Sepolia 余额偏紧，下一轮再做 Sepolia 重部署
前先从水龙头补充。

## 4. 节点接线

- 配置更新（仓库外，不进提交）：`~/workspace/bite100-node/sepolia/config.yaml:59`
  与 `~/workspace/bite100-node/base/config.yaml:59` 的 settlement 分别指向
  新地址；`~/workspace/tools/bite100-node/ensure.sh` 模板（106 / 172 行）
  同步更新，否则 watchdog 会在 10 分钟内把配置改回去。
- 二进制重建：首次 `go build` 因 worktree 脏树 VCS stamping 报错而静默
  失败（`error obtaining VCS status: exit status 128`，`&& echo BUILD_OK`
  未打印），重启后跑的仍是旧二进制；**教训：本 worktree 内一律用
  `-buildvcs=false` 构建**。重建后二进制 55,849,392 字节（旧 55,824,584），
  两节点重启，日志确认新签名域（`chainId=11155111
  verifyingContract=0x9f063683…`，`chainId=84532
  verifyingContract=0x230887F4…`），提交器已启用；公共 API
  `/api/orderbook` 响应正常。
- API 侧 ERC-1271 回退：`node/internal/api/server.go`——`handlePostOrder`
  与撤单处理在纯 ecrecover 校验失败且配置了 RPC/settlement 时，改走
  链上校验（10 秒超时上下文；RPC 错误 → fail-closed 400）。
  `node/internal/match/signature.go` 新增 `VerifySignedOrderOnChain` /
  `VerifyOrderSignatureOnChain` / `VerifyCancelSignatureOnChain`（纯校验
  先行，失败时 eth_call `Settlement.verifyOrderSignature` 或用户合约
  `isValidSignature`，比对 magic `0x1626ba7e`）；`node/cmd/node/main.go`
  为 Server 注入 `RPCURL` 与 `SettlementAddr`。
- 仅格式化了我改动的文件；仓库原有 gofmt 脏文件（consensus.go、
  engine.go 等）未动。

## 5. 两处超时修复（第 26 轮验收遗留）

### 5.1 提交器超时误判

新增 `node/internal/settlement/txverdict.go`：`ErrTxPending` /
`ErrTxDropped`；`lookupReceipt`（有回执 → 返回；无回执 → 查 mempool
区分 pending / dropped；RPC 错误 → transient）；`waitMinedVerdict`
（先 WaitMined，任何失败后用全新 30 秒上下文查回执；仅回执确认 revert
时才返回确定性失败；pending / dropped 返回 hash + 对应 sentinel，
**hash 必须返回**——提交器需要它做日志与对账，早期版本误返回 `""`
已修正）。

`node/internal/settlement/submit.go`：`SubmitTrade` 与
`ChargeFailedSettlement` 改用 `waitMinedVerdict`（删两处 `bind.WaitMined`
块与无用 `types` 导入）。`node/internal/settlement/submitter.go`：
settleOnce 分支——带 hash 的错误仅当**不是** `ErrTxPending` /
`ErrTxDropped`（`errors.Is` 判断）时才记 terminal 失败；pending /
dropped 带 hash 时记录 hash 并重试（重试前先对账，已上链的 fill 不会
重复提交）。

### 5.2 sendVaultTx 超时定论 + 动态 gas

`node/internal/settlement/lock.go`：`sendVaultTx` 改用 EIP-1559 动态费
（`SuggestGasTipCap` + 2× baseFee 上限；无 EIP-1559 时回退 legacy
`SuggestGasPrice`；签名器改 `types.LatestSignerForChainID`）；超时后
用 `lookupReceipt`（全新 30 秒上下文）定论。`LockOrder` 幂等：先算
digest、**先查已落锁**再做可用余额检查（已落锁会减少可用余额，顺序
关键；剩余充足 → 直接成功返回空 txHash；记录存在但不足 → 报错）。
新增 `suggestDynamicFees`。

### 5.3 回归测试

- `node/internal/settlement/submitter_test.go`：新增
  `TestSubmitterTimeoutWithoutHashRetries`（fake 返回 `("", timeoutErr)`
  → 重试到 maxAttempts=2，失败且 TxHash 为空）与
  `TestSubmitterPendingHashRetries`（fake 返回 `("0xpending",
  ErrTxPending)` → 重试到 2，失败且 TxHash 为空）；既有
  `TestSubmitterOnChainRevertIsTerminal` 仍通过（无 sentinel 的 revert
  错误 → 1 次即 terminal，hash 已记录）。
- `node/internal/settlement/e2e_anvil_test.go`：新增
  `TestAnvilVaultERC1271Settles`（anvil 上部署新 Settlement +
  MakerVault + MockAggregatorV3；入金 1000 USDT；金库买 0.01 BTC，
  对手卖；纯校验 false、链上校验 true；LockOrder 幂等——第二次调用
  成功返回空 txHash；SubmitTrade 结算；断言金库 BTC 0.009999e18、
  USDT 241.7766e18、NAV 999.92417766e18、份额 1000e18、双方 nonce
  1/1）与 `TestAnvilTxVerdict`（已挖交易 → 回执 status 1；未知 hash
  → ErrTxDropped；nonce 缺口排队交易 → ErrTxPending；2 秒上下文对
  pending 交易调 waitMinedVerdict → hash + ErrTxPending）。
  测试期教训：(a) 对手钱包须先充 ETH（否则 approve 在 anvil 的
  `eth_estimateGas` 报 "Out of gas: gas required exceeds allowance: 0"）；
  (b) `SendTransaction` 只代表进 mempool，anvil 即时出块仍是异步，
  查回执前须 `bind.WaitMined`；（c）`setSigner` 角色从合约读
  `ROLE_MARKET_MAKER`，不硬编码。

## 6. E2E 证据（真实交易，双链）

E2E 工具：`~/workspace/tmp-build/e2e27-r27`（源码
`~/workspace/tmp-build/e2e27-r27-src/main.go`；因 Go internal 包规则，
在 worktree 内临时 `node/cmd/e2e27/` 构建后删除该目录）。逻辑：读实时
Chainlink 价 → 读金库与对手方链上 nonce → 签名者密钥签金库买单
（自检：纯 ecrecover 校验**必须**为 false）→ 对手方签卖单 → 先后 POST
到公共 API → 轮询 `/api/trades` 最长 4 分钟。

入金（本轮）：Sepolia 与 Base 各由部署者 approve + deposit **1000 USDT**
进 MakerVault（各得 1000e18 份额）；Sepolia 对手方 maker 钱包交易 Vault
内已有 0.04 BTC；Base 对手方 taker 钱包转入并存入 0.01 ETH-mock。

### 6.1 Sepolia：金库买入 0.01 BTC @ $75,696.05

- 订单：`order_r27e2e-sepolia-1794073769_vaultbuy`（金库）+
  `order_r27e2e-sepolia-1794073769_countersell`（maker 钱包）；
  交易 `order_r27e2e-sepolia-1794073769_countersell-order_r27e2e-sepolia-1794073769_vaultbuy-1`。
- 结算 tx **`0xaa65cf0b5b5b0f61f241c547a1a8000e47645870c83531be2152aaefd07c5c21`**，
  区块 **12085248**，status 1，gasUsed 1,322,687（7× 计量值），to 新 Settlement。
- 结算后链上读数：金库 BTC **0.009999e18**、USDT **243.0395e18**、
  `totalAssets` **999.92430395e18**、totalSupply 1000e18、金库 nonce 1、
  maker nonce 1。
- 对账：243.0395 + 0.009999 × 75696.05 = 999.92430395，精确吻合；
  相对 1000 的差额 0.07569605 USDT = 0.01% 交易费（0.000001 BTC ×
  $75,696.05），本腿 gas 扣除低于显示精度。

### 6.2 Base Sepolia：金库买入 0.01 ETH @ $2,232.06941358

- 订单：`order_r27e2e-base-1794073838_vaultbuy`（金库）+
  `order_r27e2e-base-1794073838_countersell`（taker 钱包）；
  交易 `order_r27e2e-base-1794073838_countersell-order_r27e2e-base-1794073838_vaultbuy-1`。
- 结算 tx **`0xf9846ee5fd5d369a0a9a7eb048717041d20885f42104e3f7c63239c56575ad5e`**，
  区块 **55759941**，status 1，gasUsed 505,686，to 新 Settlement。
- 结算后链上读数：金库 ETH **0.009999e18**、USDT **977.6793058642e18**、
  `totalAssets` **999.99776793058642e18**、totalSupply 1000e18、金库
  nonce 1、taker nonce 1。
- 对账：977.6793058642 + 0.009999 × 2232.06941358 = 999.99776793058642，
  精确吻合；差额 0.00223206941358 USDT = 0.01% 交易费（0.000001 ETH ×
  $2,232.06941358）。

### 6.3 EOA 回归：新 Settlement 上的 EOA 对 EOA 交易（Sepolia）

工具 `~/workspace/tmp-build/e2e26-reg`（第 26 轮脚手架，settlement 地址
换成新地址）。maker 卖 1 TKA @ 1.0，taker 买：结算 tx
**`0xf9442bc1b73288b645154e6291fe2cf6bd906298c888719faa75949a0e8001a9`**，
区块 **12085261**，status 1，gasUsed 1,173,428，to 新 Settlement。
证明新 Settlement 的 EOA 快速路径未被 ERC-1271 改动破坏。

完整链路已证：API ERC-1271 回退 → 节点落锁 → 撮合 → 提交器 →
新 Settlement 结算。

## 7. 门禁结果（2026-11-08）

| 门禁 | 结果 |
|---|---|
| forge | **131/131 通过**（基线 119 + 新增 12 个 MakerVault 测试，13 个 suite） |
| go test ./... | 全部通过（api、match、relay、reward、settlement、storage；cmd/* 无测试文件） |
| go vet ./... | 干净 |
| anvil E2E（`bash scripts/anvil-e2e.sh`） | **4/4 通过**：TestAnvilE2E（20.15s）、TestAnvilVaultERC1271Settles（24.15s）、TestAnvilTxVerdict（3.01s）、TestAnvilMarketOrderE2E（42.21s） |
| npm test | **169/169 通过**（15 个文件；5 个断言旧 Settlement 地址的测试已随迁移更新，见下） |
| npm run build | 通过（tsc -b + vite build，4.29s；chunk > 500 kB 警告为既有） |

前端改动：`frontend/src/config/chains.ts` 的 settlement 地址（Sepolia
79 行、Base Sepolia 145 行）指向新 Settlement（EIP-712 域随之切换）；
`src/config/chains.test.ts` 与 `src/services/orderSigningTypes.test.ts`
中 5 处断言旧地址的期望值同步更新为新地址（其余测试未动）。

## 8. 如何使用金库（用户说明）

金库是一个 ERC-4626 保险库：你存入 USDT 得到份额，份额代表你在金库净资产
（NAV）中的占比；金库用这些资金在比特100 上做市交易，盈亏直接反映在
NAV（从而反映在你的份额价值）里。

**存款（deposit / mint）**
- 调用 `MakerVault.deposit(USDT 数量, 你的地址)`：USDT 自动转入交易
  Vault 参与做市，你按当时 NAV 得到份额。首次存款 1000 USDT 得 1000
  份额（1:1）；之后按 `份额 = 金额 × 总份额 / 总资产` 计算。
- 存款没有锁定期，但存入后资金即进入交易 Vault，取款受 §锁仓 约束。

**取款（redeem / withdraw）**
- 调用 `MakerVault.redeem(份额, 你的地址, 你的地址)`：按当时 NAV 把
  份额换回 USDT。金库会从交易 Vault 拉回所需资金。
- **锁仓约束**：如果金库的资金正被未成交订单锁定（挂单中），对应部分
  取不出来，redeem 会失败；等订单成交、取消或过期释放后即可取。
  这是设计使然——已承诺给对手方的资金不能先被抽走。

**暂停（pause）**
- 仅 owner 可执行。暂停后：不能再存款、签名者不能再下单；**取款与签名者
  轮换不受影响**。暂停是紧急制动，不是冻结资金。

**签名者（signer）**
- 金库的交易由注册签名者代签：签名者只能下单交易，**不能提款、不能动
  你的份额**。签名者由 owner 通过 `setSigner(地址, 角色, 是否授权)`
  注册/轮换/撤销；角色分 `MARKET_MAKER`（做市）、
  `SETTLEMENT_SUBMITTER`（结算提交）、`RELAYER`（中继），同一注册表
  未来承载结算与 nodeless 中继角色。
- 当前签名者：`0x05040D9e…`（双链同地址），仅 `MARKET_MAKER` 角色。

**策略与价格**
- 金库围绕 Chainlink 参考价报价（BTC/USDT 用 BTC/USD feed，ETH/USDT 用
  ETH/USD feed）；没有已核实 feed 的交易对不报假价、不交易。
- 若 Chainlink feed 过期（超过心跳 3 倍），NAV 计算会失败而非用过期价
  ——这是 fail-closed 设计，存款与取款都会暂停直到价格恢复。

**费用**
- 交易费 0.01%（每笔成交扣），99% 进 FeeDistributor、1% 归开发者。
- 结算 gas 由中继先垫付，成交后买卖双方各承担一半，从各自收到的资产
  里扣（第 21 轮规则；单方扣除不超过收到金额的 10%）。
- 存款/取款本身的链上 gas 由你自付。

**风险提示**
- 存款人承担全部盈亏：做市亏损会降低 NAV，你的份额价值随之下降；
  盈利则上升。不存在保本。
- 金库目前没有前端界面，存款/取款需通过合约调用（cast / ethers）；
  前端金库页面是后续轮次的工作。
- 本轮部署在测试网（Sepolia / Base Sepolia），资产为 mock 代币，
  仅用于验证流程，不构成任何主网承诺。

## 9. 需要主聊天 / Ren 拍板的事项

1. **Settlement 重新部署（ERC-1271）——本轮 #1 决策项**。为让金库合约
   当交易用户、签名者只能交易不能提款，Settlement 必须支持 ERC-1271，
   因此部署了新 Settlement 并切换了 Vault 指针、节点配置与前端域。
   请主聊天复核：此迁移是否接受为本轮的正式方案（旧 Settlement 在测试
   网已取代；主网部署时直接按新版部署即可，不存在主网迁移问题）。
2. **迁移前提已满足但须留档**：切入时节点库零待结算交易；部分成交的
   开放订单在新 Settlement 下按剩余量成交安全，但旧全量 fill 若被过期
   重提交，新 Settlement 的空 `orderFilled` 无法链上识别——测试网切入
   前已排空，未来如再有类似迁移须同样先排空待结算队列。
3. **金库前端页面**未在本轮做（存款/取款/NAV 展示需另起一轮或并入下
   一轮前端工作）。
4. **Sepolia 部署者余额偏紧**（0.01163 ETH）：下一轮再做 Sepolia 重部署
   前先从水龙头补充。

## 10. 已知限制（不在本轮范围，只记录）

- 成交记录 `amountOut` 失真 ×1e18（第 26 轮遗留）。
- `GET /api/trades` 空结果返回 `null` 而非 `[]`，且不支持 `since`
  参数（窗口固定约 7 天）。
- 部署二进制脏树构建问题（本轮节点二进制系 worktree 脏树构建；
  另见 §4 的 `-buildvcs=false` 教训）。
- Frontend CI runner undici 崩溃（环境/Node 版本问题，非代码问题）。
- 金库无前端 UI（见 §8 末尾）。
- 本轮新 Settlement 的部署与配置沿用第 21 轮的 gas 参数
  （meterKeepBps 7600 等）；主网前仍需按第 21 轮记录在主网分叉重新校准，
  失败扣费功能上线时保持 OFF。
- DVN 1-of-1 主网门禁不变；主网零操作；Ren 的钱包未动。
