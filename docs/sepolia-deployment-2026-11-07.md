# Bit100 Sepolia 测试网部署与结算验证记录（2026-11-07）

> **后续（2026-11-07 第十五轮）**：本链十合约已因挂单余额锁定重新部署，Sepolia 现行地址以 `docs/round15-deployment-2026-11-07.md` 为准；本文件保留为历史部署记录。

本轮（第三轮）将第二轮修复后的合约全套部署到 Sepolia 测试网，并用 Go 节点撮合 + `SubmitTrade`
完成真实链上结算验证。全程未 push、未改前端配置、未触碰旧线上合约（旧地址保持不变）。

## 网络与账户

- 网络：Ethereum Sepolia（chainId 11155111），RPC：`https://ethereum-sepolia.publicnode.com`
- 部署钱包：`0x4B3fbb64ed7F3CD892484154EC684C1eFC8fa93e`（本轮新建的测试网专用钱包）
  - [Etherscan](https://sepolia.etherscan.io/address/0x4B3fbb64ed7F3CD892484154EC684C1eFC8fa93e)
  - 水龙头注资 tx：[0x760a38fae2175ff5b52e3f64bd12f74db8aa74ed6ea403b0000ae1eb498f114c](https://sepolia.etherscan.io/tx/0x760a38fae2175ff5b52e3f64bd12f74db8aa74ed6ea403b0000ae1eb498f114c)（0.1025 ETH）
- 测试账户：maker `0xE83D2b08356cb463adFc20406a18B79991F7eE29`、taker `0x87ffF84eb917916587fA7721c843cdC3Ada957eA`

## 新部署合约（forge script Deploy.runWithAmmAndMocks）

| 合约 | 地址 | 部署 tx |
|---|---|---|
| Vault | [0xb4945C5E0208803FF11d0f86173B55489aE87d2A](https://sepolia.etherscan.io/address/0xb4945C5E0208803FF11d0f86173B55489aE87d2A) | [0xe3c252e9…b873e](https://sepolia.etherscan.io/tx/0xe3c252e91a815cda54fa0b995112395e8340e62fd083577d37b657c7b04b873e) |
| FeeDistributor | [0x346DE29B7fEe95F44A5b5385e87182F031E8E1B5](https://sepolia.etherscan.io/address/0x346DE29B7fEe95F44A5b5385e87182F031E8E1B5) | [0xc1410a73…eca2](https://sepolia.etherscan.io/tx/0xc1410a735bd0f2e5ee56bbf314288d9e3def2b31bb39ad60b31cae54fd97eca2) |
| Settlement | [0xA4Eaa449360239e1F719608236d087c23379d5A6](https://sepolia.etherscan.io/address/0xA4Eaa449360239e1F719608236d087c23379d5A6) | [0xffa3c817…c111](https://sepolia.etherscan.io/tx/0xffa3c81758b454a2dbfefdba3f8381b241243af5bee2083d8c24c12bab5bc111) |

> 注：上表 Settlement 已在第五轮被新地址替代（见文末第五轮小节），Vault 的 settlement 登记已切换；
> 旧 Settlement 合约仍在链上，但不再被 Vault 认可，不能再结算。
| MockERC20 TKA (Token0) | [0x903cdDF52963D9DEA0BDF8be9159E08706683654](https://sepolia.etherscan.io/address/0x903cdDF52963D9DEA0BDF8be9159E08706683654) | [0x26cbb76a…9347](https://sepolia.etherscan.io/tx/0x26cbb76a0537451c7c906469d3edc226cb8c3b6c2f80142aeda0489504eb9347) |
| MockERC20 TKB (Token1) | [0x1Ee28c1c490727e49939C95032C749ea5b58b45f](https://sepolia.etherscan.io/address/0x1Ee28c1c490727e49939C95032C749ea5b58b45f) | [0xed94418ae…4dec](https://sepolia.etherscan.io/tx/0xed94418ae2d238ce42d3c62733da0d4c199891858a9bf5129b48b6de7bc64dec) |
| AMMPool | [0x20a78bCb39Ff510AdBa3D3AEC9229a9583C5BDB3](https://sepolia.etherscan.io/address/0x20a78bCb39Ff510AdBa3D3AEC9229a9583C5BDB3) | [0x62300dd2…ea19](https://sepolia.etherscan.io/tx/0x62300dd2ca6fd4a513593c03ec25ce54c153e78067199559d1da3e516284ea19) |

另有 3 笔部署内配置交易（Vault 绑定、FeeDistributor 开发者地址与接收方设置），见本地
`contracts/broadcast/Deploy.s.sol/11155111/runWithAmmAndMocks-latest.json`（该目录被 .gitignore 排除，未入库）。

配置要点（沿用部署脚本）：FeeDistributor 开发者 = 部署钱包，手续费 1% 自动转开发者、
99% 进分配池（接收方 = 部署钱包，shareBps 9900）；Settlement 费率 1bp 双边。

## 结算验证（node/internal/settlement/e2e_sepolia_test.go）

流程：部署者给 maker/taker 注 gas（各 0.01 ETH）与测试币 → maker 存 100 TKA、taker 存 200 TKB 进
Vault → 按 `docs/eip712-order-spec.md`（chainId 11155111）双边 EIP-712 签名（maker 卖 100 TKA @ 2
TKB/TKA，taker 全额吃单）→ 节点撮合 1 笔 → `SubmitTrade` 经部署者提交 `settleTrade`（合约侧验签）
→ 断言 → 同一成交重放。

共完成 **3 笔真实结算**（测试迭代期间各跑一笔）：

| # | 结算 tx | nonce 变化 | 结果 |
|---|---|---|---|
| 1 | [0xbc2108a9…36d5](https://sepolia.etherscan.io/tx/0xbc2108a9d93c22630478a76900794f90c68dc21d937ae3c59dd6574fb5bc36d5) | 0 → 1 | 核心断言通过（手续费断言按旧口径，后经复核为部署配置差异，见下） |
| 2 | [0x5ec35f5e…8c5](https://sepolia.etherscan.io/tx/0x5ec35f5e6cf8f1d407c78e747c605663e9499411c380bb3c2ce24c06970f18c5) | 1 → 2 | 链上最终状态经逐项复核全部正确（测试内 2 项读数被公共 RPC 旧状态误报） |
| 3 | [0xffdd9301…df75](https://sepolia.etherscan.io/tx/0xffdd930182893be5c5600bd9d845c08085c9e00b9d01cda0bc1a078d413bdf75) | 2 → 3 | **全量 PASS：10/10 断言一次收敛 + 重放被拒** |

每笔断言（增量口径，均通过）：

- maker Vault：TKA −100、TKB +199.98
- taker Vault：TKB −200、TKA +99.99
- FeeDistributor：TKA +0.0099、TKB +0.0198（名义手续费 0.01 / 0.02 的 99%）
- 开发者（部署钱包）：TKA +0.0001、TKB +0.0002（手续费 1% 自动转）
- maker / taker 结算 nonce 各 +1
- 重放同一成交：链上拒绝，`Settlement: fill exceeds signed order`

注资 tx（第 1 笔结算前）：maker [0x355ab925…88ae](https://sepolia.etherscan.io/tx/0x355ab925f15c60f2abda73a96d4b9b6b026d158cd55ee5a63b653250757988ae)、
taker [0x521c9f09…df0](https://sepolia.etherscan.io/tx/0x521c9f09df7a2b6eebbb61049e77b7f7ce043561d8f4ddfb83723bb9810afdf0)。

## 本轮对测试做的三处适配（均已写入测试注释）

1. **注资 gas limit 21000 → 500000 并校验回执状态**：经 publicnode 的 Sepolia 入口 gas 计量
   非标准——给新地址的普通 ETH 转账实测消耗约 204600 gas（水龙头注资 tx 同口径），
   21000 必定 OOG 且回执 status=0；原测试未查回执状态，前两跑因此误判已注资、
   在 approve 处报 `gas required exceeds allowance (0)`。
2. **手续费断言改按部署配置口径**：anvil 版未给 FeeDistributor 设开发者地址（FD 留存 100%），
   forge 部署脚本设了 developer=deployer，`receiveFee` 按合约设计先转 1% 给开发者、
   FD 留 99%。断言据此拆分 FD 增量（99%）与开发者钱包增量（1%）。
3. **断言改为增量口径 + 轮询收敛**：增量口径使测试可重复运行（每跑一笔新结算）；
   公共 RPC 多后端状态传播有延迟，个别 `eth_call` 可短暂读到旧状态，断言轮询至
   全部收敛或超时（第 3 笔第 1 轮即收敛）。

## 遗留与说明

- 本次为全新部署，新合约地址与旧线上地址不同；前端仍指向旧地址，本轮未切换（待 Ren 决定）。
- publicnode 免费入口的 gas 计量与状态传播特性如上，生产化验证建议换专用 RPC。
- 部署钱包与测试账户均为测试网专用，私钥不在本仓库内。

## 第四轮追加（2026-11-07）：开发者分成方案 B——1% 改治理可调（上限 5%）

Ren 拍板：将 FeeDistributor 写死的开发者分成（原常量 `DEVELOPER_SHARE_BPS = 100`，注释「永久 1%」）
改为治理可调，保留默认 1%，硬上限 5%。

### 合约改动（contracts/src/FeeDistributor.sol）

- 常量 `DEVELOPER_SHARE_BPS` 改为状态变量 `developerShareBps`（默认 100），另加硬上限常量
  `MAX_DEVELOPER_SHARE_BPS = 500`。
- 新增 `setDeveloperShareBps(uint16)`：仅 owner 或 governance 可调用，超过 500 时 revert
  （`FeeDistributor: share too high`），变更发事件 `DeveloperShareSet(oldBps, newBps)`。
- `receiveFee` 与 `setRecipients` 的上限计算改读该变量；顺带修正了头部注释中误写的「5%」字样。
- 测试：新增 7 个用例（默认值、3% 分成、0%、500 边界、501 revert、未授权 revert、governance 可调），
  forge test **69/69 全绿**（此前基线 62/62）。

### 新 FeeDistributor 部署与配置

| 项目 | 值 / tx |
|---|---|
| 新 FeeDistributor | [0xB63a3D858E5230233e4D1B76052387C2274d6e3A](https://sepolia.etherscan.io/address/0xB63a3D858E5230233e4D1B76052387C2274d6e3A) |
| 部署 tx | [0x1e451d4f…ff90d](https://sepolia.etherscan.io/tx/0x1e451d4fa52f26cf59aa246633c6697beb62faf8b7118ee4f73570835e4ff90d) |
| setDeveloperAddress → Ren 钱包 `0x047df18eF5484945D33fBddB8D58D382597354d9` | [0x6643caac…337f](https://sepolia.etherscan.io/tx/0x6643caacc88364f3c37e487948c076d7bcac768cca067d9493dafcc89d70337f) |
| setRecipients（复制旧配置：部署钱包 9900） | [0x822814cb…9388](https://sepolia.etherscan.io/tx/0x822814cba566aa4342f2b126f5104dbf980ae760576f7e828754a10ec1399388) |

旧 FD 的 governance 为零地址（未设），新 FD 同样未设，无需复制。链上读回确认：
developer = Ren 地址、developerShareBps = 100（默认 1%）、totalShareBps = 9900。

### 链上验证（逐项）

- **可调性**：owner 调 `setDeveloperShareBps(200)` 成功（tx
  [0x27295caa…23e1](https://sepolia.etherscan.io/tx/0x27295caa7348239effb21bb02fc9a437c27f03cf79688a6380a367a432e223e1)，
  读回 200），再调回 100（tx
  [0x31dd21b5…7a17](https://sepolia.etherscan.io/tx/0x31dd21b52d5777bd547fbd056732aa41af6fd91902e89a66c26a4077a17b1c7a)，
  读回 100）；调 501 在链上直接 revert（`FeeDistributor: share too high`）。
- **新 FD 分账**：部署钱包授权并直接调用新 FD 的 `receiveFee(TKA, 100)`（tx
  [0x41cc21ec…53c8](https://sepolia.etherscan.io/tx/0x41cc21ec98486b6c61aa283502b8441c1ba87e8bc5209b38e07cb3b8e9653c8d)）：
  Ren 地址 TKA 0 → **1**（1% 自动到账），新 FD 留存 **99** TKA、accumulated = 99 TKA，与 99/1 口径一致。
- **AMMPool 已切换**：`setFeeDistributor(新 FD)` 成功（tx
  [0xc3263070…0309](https://sepolia.etherscan.io/tx/0xc32630709913b22bf0f2de5951a6abf29434691973c033e007d7415bce369030)），
  读回 AMMPool.feeDistributor = 新 FD。AMM 路径的手续费自此进入新 FD。
- **Settlement 未能切换（阻塞项）**：Settlement 的 `feeDistributor` 仅在构造函数中设定，
  **合约没有 setter**，无法在不重部署 Settlement 的前提下指向新 FD。按任务约束本轮未擅自重部署，
  Settlement 路径的手续费目前仍进入旧 FD `0xfb458224…768b21`（其 developer 仍为部署钱包）。
  因此本轮没有重跑 Settlement 的 e2e 结算来验证新 FD（跑了也只会进旧 FD）；新 FD 的分账改用
  上面的 `receiveFee` 直调完成等效验证。若要全量切换，需 Ren 批准重部署 Settlement
  （并连带处理 Vault/节点对 Settlement 地址的引用）。

## 第五轮追加（2026-11-07）：Settlement 方案 B——加 setFeeDistributor 并重部署，全量切换新 FD

Ren 拍板方案 B：不直接重部署了事，而是先给 Settlement 补上 `setFeeDistributor` setter
（消除「手续费落地写死在构造函数」的设计缺陷，以后换 FD 只需一笔交易），再重部署
Settlement 指向第四轮的新 FeeDistributor，使订单簿路径手续费全量切换到新 FD。

### 合约改动（contracts/src/Settlement.sol）

- 新增事件 `FeeDistributorSet(oldDistributor, newDistributor)`（均 indexed）。
- 新增 `setFeeDistributor(address)`：仅 owner 或 governance（沿用既有
  `onlyOwnerOrGovernance` 风格，与 `setFeeBps` 一致），零地址 revert
  （`Settlement: zero address`），变更发事件。
- 测试：Settlement.t.sol 新增 5 个用例（owner 可设且事件正确、governance 可设、
  未授权 revert、零地址 revert、切换后一笔结算的手续费落入新 FD 而旧 FD 为 0），
  forge test **74/74 全绿**（此前基线 69/69）。

### 新 Settlement 部署与绑定补齐

部署脚本：`contracts/script/DeploySettlementV2.s.sol`（构造参数：沿用共用 Vault +
新 FD），一次 broadcast 完成部署与 Vault 绑定。

| 项目 | 值 / tx |
|---|---|
| 新 Settlement | [0xee35587f3e3f500de9f9E1E97c340F801dc71078](https://sepolia.etherscan.io/address/0xee35587f3e3f500de9f9E1E97c340F801dc71078) |
| 部署 tx | [0xf96b9e61…f2d2](https://sepolia.etherscan.io/tx/0xf96b9e611475f38cf6cdde3ffee73140e41b8c6dd75a034d37f678cc45f4f2d2) |
| `Vault.setSettlement(新 Settlement)` tx | [0x76351f64…7952](https://sepolia.etherscan.io/tx/0x76351f64fbf380e366454b8a7d376bedbb046fae2df7291ec16122d4fcf57952) |
| 旧 Settlement（已被替代） | [0xA4Eaa449360239e1F719608236d087c23379d5A6](https://sepolia.etherscan.io/address/0xA4Eaa449360239e1F719608236d087c23379d5A6) |

绑定补齐清单（逐项核对旧实例链上状态后确认）：旧实例在 Deploy.runWithAmmAndMocks 中的
外部绑定只有 `Vault.setSettlement` 一项；governance、relayer、nodeRewards、founder、
usdtToken、feeToken 均为零值，feeBps = 1、feeCapPerToken(TKA/TKB) = 0、
minRelayerReputation = 5000、maxGasReimbursePerTrade = 0 均为合约默认值——新实例
默认值与之一致，无需复制，也未动 Vault 的任何其他配置。链上读回确认：新
Settlement 的 feeDistributor = 新 FD、vault = 共用 Vault、owner = 部署钱包、
feeBps = 1；Vault.settlement = 新 Settlement。

### setter 链上往返证明（新实例的 setFeeDistributor 可用）

| 步骤 | tx | 读回 |
|---|---|---|
| owner 设 feeDistributor → 旧 FD `0xfb458224…768b21` | [0x9debcab6…99f2](https://sepolia.etherscan.io/tx/0x9debcab653195c175085e12862bd0a10f06298395f917f3d0d7ce193c76999f2) | 旧 FD ✓ |
| owner 设回 → 新 FD `0xB63a3D85…6e3A` | [0x0490f767…7915](https://sepolia.etherscan.io/tx/0x0490f7676adf9c138080d25a37ab785682a842f1353272fa6c1c87c2527b7915) | 新 FD ✓（最终状态） |

### 结算再验证（对新 Settlement 重跑 e2e_sepolia_test.go）

测试改动：断言的开发者地址改为从 FeeDistributor 合约 `developerAddress()` 读回
（自动跟随新 FD 的 Ren 地址），其余流程与第三轮一致。结果 **PASS（首轮断言即收敛）**：

- 结算 tx：[0xcab918af…0d35](https://sepolia.etherscan.io/tx/0xcab918af5b0105b1d1f16dd282c6e3163e136eb4114530c1cbcd4ff4d8540d35)
- maker / taker 结算 nonce（新 Settlement 上从 0 起算）：0 → 1 ✓
- maker Vault：TKA −100、TKB +199.98 ✓；taker Vault：TKB −200、TKA +99.99 ✓
- 手续费进**新 FD**：TKA +0.0099、TKB +0.0198（名义手续费 99%）✓
- 开发者分成 1% 落 **Ren 地址 `0x047df18e…354d9`**：TKA +0.0001、TKB +0.0002 ✓
  （第三轮时该项落部署钱包，本轮起改落 Ren 地址）
- 同一成交重放：链上拒绝（`Settlement: fill exceeds signed order`）✓

仓库内引用核查：旧 Settlement 地址在源码/配置中无其他默认引用（仅本文件历史记录），
无需连带更新；前端仍指向更早的旧线上地址，未在本轮范围内切换（待 Ren 决定）。

## 第六轮：四合约全补（Ren 拍板"全补"方案）

第五轮后前端 Sepolia 配置里 governance / contributorReward / tokenRegistry /
chainConfig 四位仍为零地址。本轮按 Ren 拍板的"全补"方案，用
`contracts/script/Deploy.s.sol` 的现成入口把四个合约全部署并接线，至此
2026-11-07 新部署共十个合约全部就位。部署钱包仍为
`0x4B3fbb64ed7F3CD892484154EC684C1eFC8fa93e`。

### 新部署的四个合约

| 合约 | 地址 | 部署 tx |
|---|---|---|
| ContributorReward | `0xfe066c25a25fddd6433fac7f7769d5806392663e` | [0x6cc87fb4…0e51](https://sepolia.etherscan.io/tx/0x6cc87fb4bf630893b7951ff099c74cdb7d8d43efb1382b7c91867b270d9a0e51) |
| Governance | `0x26b608468bf5dd88b91eae3d16827a2b4a25bcce` | [0x34c4cca7…9f13](https://sepolia.etherscan.io/tx/0x34c4cca71988fabe9895c1c6c5dab4c966d812e665cb8bc55299a30eaa9f9f13) |
| TokenRegistry | `0x8dc560038d392012c8562185e4c6bf2ce636e74d` | [0xfd36b13d…03da](https://sepolia.etherscan.io/tx/0xfd36b13de87161779f61647a0e073147d3a69563c8f2675d2da8340f35b003da) |
| ChainConfig | `0x439423ab16a1a3dadf5415243501ee9e6984b813` | [0x3b4d8964…0f74](https://sepolia.etherscan.io/tx/0x3b4d8964dbe4136e2537a1c15be1df29ad18a268dc9a8756bdbb510d68600f74) |

### 接线清单（共 11 笔交易：4 部署 + 7 setter）

执行顺序：`runContributorReward()` → `runGovernance()`（脚本一次回填四处
setGovernance，无需补笔）→ `runTokenRegistryAndChainConfig()` → 手工补
`AMMPool.setContributorReward` 一笔。

| 接线 | tx |
|---|---|
| Settlement.setGovernance → 新 Governance | [0x10ae39fc…f01d](https://sepolia.etherscan.io/tx/0x10ae39fc2ad68d2ef1eb9672ae13991c25c9f378ffa1ae6d848cd4403404f01d) |
| AMMPool.setGovernance → 新 Governance | [0xffddb7d2…7485](https://sepolia.etherscan.io/tx/0xffddb7d2bc77e13b934281d1d9570700b3b4e45c575f68e146a7589bf6b97485) |
| ContributorReward.setGovernance → 新 Governance | [0x9a0e82e1…f5458](https://sepolia.etherscan.io/tx/0x9a0e82e1422e0b81d6cc9b478b9205cccafd063cf020b1f4f7b3a2affa9f5458) |
| FeeDistributor.setGovernance → 新 Governance | [0x9e16f8ec…2c71](https://sepolia.etherscan.io/tx/0x9e16f8ec58953646ff667ed519bd2152a3d61ca945682e643ce7be1a0b122c71) |
| TokenRegistry.setGovernance → 新 Governance | [0x70d0d64b…dfa0](https://sepolia.etherscan.io/tx/0x70d0d64b98c8f4e61afe256c4c11474b917e7c78047480f1baf42a0c03d9dfa0) |
| ChainConfig.setGovernance → 新 Governance | [0x68946bce…4960](https://sepolia.etherscan.io/tx/0x68946bceddf56f8911fa6a761a4c0ea3b62c19dd8796f3ee5702ea428aaf2496) |
| AMMPool.setContributorReward → 新 ContributorReward | [0x000f2e6f…8546](https://sepolia.etherscan.io/tx/0x000f2e6f6da760144d8792cf3dee9062b41455b7ec63a2edd3f95a3bb85b8546) |

### 链上验证（逐项读回，全部通过）

- 四个新地址均有代码（字节码约 10.4 KB / 9.5 KB / 1.6 KB / 1.5 KB）✓
- `Settlement.governance()`、`AMMPool.governance()`、`FeeDistributor.governance()`、
  `ContributorReward.governance()`、`TokenRegistry.governance()`、
  `ChainConfig.governance()` 六处读回均 == 新 Governance `0x26b60846…5bcce` ✓
- `AMMPool.contributorReward()` == 新 ContributorReward `0xfe066c25…2663e` ✓

### 余额消耗

部署钱包：部署前 0.080608 ETH → 本轮后 0.073916 ETH，本轮 11 笔交易共耗
≈ 0.006692 ETH（Sepolia 测试币）。

### 前端与注意事项

- 前端 `chains.ts` Sepolia 段四位已填新地址（段首注释改为"十合约全部署"），
  `npm test` 77/77 全绿，构建产物已确认含新 Governance 地址。
- **两个登记表目前是空表**：TokenRegistry 尚无任何代币登记、ChainConfig 尚无
  任何链登记。两者的增删只认治理提案（创建提案 → 7 天投票 → 2 天 timelock →
  执行），把 TKA/TKB 正式登记最快也要 9 天后，且需先备好贡献者活跃集的
  Merkle 树。本轮只是把合约部署并接线到位，**未** populated 任何数据。
- ContributorReward 尚未注入任何周期的奖励池（需 owner 调
  `setPeriodReward`），治理区与贡献奖励页面即日起可连到真实合约，但暂无
  可领取奖励；Governance 也尚无提案（提案需附活跃集 Merkle 根）。
