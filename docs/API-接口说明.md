# P2P 去中心化交易所 - API / 接口说明

> 版本：v0.1  
> 更新日期：2025-02-07  
> 关联文档：[技术架构说明](./技术架构说明.md)、[Phase2 设计文档](./Phase2-设计文档.md)

---

## 一、链配置

### 1.1 已部署网络：Sepolia 测试网

| 项 | 值 |
|----|-----|
| Chain ID | 11155111 |
| RPC | `https://ethereum-sepolia.publicnode.com` |
| 区块浏览器 | https://sepolia.etherscan.io |

### 1.2 合约地址（Sepolia）

| 合约 | 地址 |
|------|------|
| Vault | `0xbe3962Eaf7103d05665279469FFE3573352ec70C` |
| FeeDistributor | `0xeF4BFB58541270De18Af9216EB0Cd8EC07a2547F` |
| Settlement | `0x493Da680973F6c222c89eeC02922E91F1D9404a0` |
| Token A (TKA) | `0x678195277dc8F84F787A4694DF42F3489eA757bf` |
| Token B (TKB) | `0x9Be241a0bF1C2827194333B57278d1676494333a` |
| AMMPool | `0x8d392e6b270238c3a05dDB719795eE31ad7c72AF` |
| ContributorReward | `0x851019107c4F3150D90f1629f6A646eBC1B1E286` |
| Governance | `0x8F107ffaB0FC42E623AA69Bd10d8ad4cfbcE87BB` |
| TokenRegistry | `0x77AF51BC13eE8b83274255f4a9077D3E9498c556` |
| ChainConfig | `0x7639fc976361752c8d9cb82a41bc5D0F423D5169` |

---

## 二、智能合约接口

### 2.1 IERC20（代币标准）

```solidity
// 读取
function totalSupply() external view returns (uint256);
function balanceOf(address account) external view returns (uint256);
function allowance(address owner, address spender) external view returns (uint256);

// 写入（需签名）
function transfer(address to, uint256 amount) external returns (bool);
function approve(address spender, uint256 amount) external returns (bool);
function transferFrom(address from, address to, uint256 amount) external returns (bool);
```

### 2.2 Vault（资产托管）

| 方法 | 类型 | 说明 |
|------|------|------|
| `balanceOf(address token, address user)` | view | 查询用户在 Vault 中某代币余额 |
| `deposit(address token, uint256 amount)` | write | 存入代币（需先 approve Vault） |
| `withdraw(address token, uint256 amount)` | write | 提取代币 |

**事件**：`Deposit`, `Withdraw`, `TransferOut`

**ABI（前端用）**：
```
function balanceOf(address token, address user) view returns (uint256)
function deposit(address token, uint256 amount)
function withdraw(address token, uint256 amount)
```

### 2.3 Settlement（交易结算）

| 方法 | 类型 | 说明 |
|------|------|------|
| `settleTrade(maker, taker, tokenIn, tokenOut, amountIn, amountOut, gasReimburseIn, gasReimburseOut)` | write | 结算链下撮合成交。仅 owner、单一 `relayer` 或白名单 `isRelayer[addr]` 可调用；当 `maxGasReimbursePerTrade > 0` 时单笔 gasReimburseIn+gasReimburseOut 不得超过该上限。 |
| `setRelayer(address)` | write | 设置单一 relayer 地址（兼容旧接口）；0 表示不启用（仅 owner） |
| `setRelayerAllowed(address account, bool allowed)` | write | 设置 relayer 白名单（多 relayer 防滥用）；仅 owner |
| `setMaxGasReimbursePerTrade(uint256 _cap)` | write | 设置单笔 settleTrade 的 gas 报销上限（token 最小单位之和）；0 表示不设上限；仅 owner |

**事件**：`TradeSettled`、`TradeSettledWithGasReimburse`（含 gas 代付时）、`RelayerSet`、`RelayerAllowedSet`、`MaxGasReimbursePerTradeSet`

**说明**：Settlement 用于链下订单簿撮合后的结算。当买卖双方无原生代币付 gas 时，可由 relayer 代付；gas 费卖方买方均摊。**Relayer 防滥用**：支持多 relayer 白名单（`isRelayer`）、单笔 gas 报销上限（`maxGasReimbursePerTrade`）。

### 2.4 FeeDistributor（手续费分配）

**开发者 1% 永久分成**：手续费的 **1%** 在每次 `receiveFee` 时**自动转入** `developerAddress`，无需手动 claim 或兑换。其余部分按 `recipients` 比例由各接收方自行 `claim`；`setRecipients` 时总比例不得超过 99%（10000 - 100 bps）。

| 方法 | 类型 | 说明 |
|------|------|------|
| `receiveFee(address token, uint256 amount)` | write | 接收手续费（由 Settlement/AMM 调用）；1% 自动转开发者，99% 进入分配池 |
| `claim(address token)` | write | 领取应得份额（仅针对 95% 分配池） |
| `claimable(address token, address account)` | view | 查询可领取金额 |
| `setRecipients(address[] accounts, uint16[] shareBps)` | write | 设置分配对象与比例（仅 owner；总比例 ≤ 9500 bps） |
| `setDeveloperAddress(address _developer)` | write | 设置开发者地址（仅 owner）；设为 0 可关闭自动转出，此时接收方比例可设至 100% |
| `developerAddress()` | view | 开发者地址 |
| `DEVELOPER_SHARE_BPS` | constant | 100（1%） |

**事件**：`FeeReceived`、`DeveloperPaid(token, developer, amount)`、`DeveloperSet`、`RecipientSet`、`Claimed`

**ABI（前端用）**：
```
function receiveFee(address token, uint256 amount)
function claim(address token)
function claimable(address token, address account) view returns (uint256)
function setDeveloperAddress(address _developer)
function developerAddress() view returns (address)
```

### 2.5 AMMPool（AMM 交易池）

| 方法 | 类型 | 说明 |
|------|------|------|
| `token0()` | view | 代币 0 地址 |
| `token1()` | view | 代币 1 地址 |
| `reserve0()` | view | 池中 token0 储备量 |
| `reserve1()` | view | 池中 token1 储备量 |
| `getAmountOut(address tokenIn, uint256 amountIn)` | view | 预览 Swap 输出量 |
| `swap(address tokenIn, uint256 amountIn)` | write | 执行 Swap（0.01% 手续费，最高 1 USD） |
| `addLiquidity(uint256 amount0, uint256 amount1)` | write | 添加流动性 |

**事件**：`Swap`, `AddLiquidity`, `RemoveLiquidity`

**ABI（前端用）**：
```
function token0() view returns (address)
function token1() view returns (address)
function reserve0() view returns (uint256)
function reserve1() view returns (uint256)
function getAmountOut(address tokenIn, uint256 amountIn) view returns (uint256)
function swap(address tokenIn, uint256 amountIn) returns (uint256)
function addLiquidity(uint256 amount0, uint256 amount1)
```

**手续费**：`feeBps = 1`（0.01%），从 swap 输入中扣除后转入 FeeDistributor；每笔最高等值 1 美元（`feeCapPerToken`，0 表示不设上限）。**可通过治理投票调整**（`setFeeBps`、`setFeeCap` 经治理合约执行）。

#### 交易费率对照币安

| 项目 | 本协议（当前） | 币安现货 |
|------|----------------|----------|
| AMM / 即时成交 | **0.01%**（单边，swap 从输入扣，最高 1 USD） | Taker 约 **0.04%～0.1%**（吃单） |
| 挂单 / Maker | **0.01%**（买卖双方各自代币，各边最高 1 USD） | Maker 约 **0.08%～0.1%**（挂单） |
| 说明 | 链上 AMM 单池、链下订单簿结算，feeBps / feeCap 可治理投票调整 | 阶梯 + BNB 抵扣等可再降；VIP 更低 |

### 2.6 ContributorReward（贡献奖励，Phase 2 M4）

按周期收集贡献证明，按贡献分占比分配该周期奖励池。**价值按周期锁定**：每周期结算时确定「每贡献分价值」，之后任何时候领取均按该周期锁定价值计算；不设 14 天作废，未领部分一直有效。详见 [贡献奖励接口 §3.3](./贡献奖励接口.md)。

| 方法 | 类型 | 说明 |
|------|------|------|
| `submitProof(period, uptime, storageUsedGB, storageTotalGB, bytesRelayed, nodeType, signature)` | write | 提交贡献证明（msg.sender 为领奖地址，signature 为 ECDSA 65 字节） |
| `setPeriodReward(period, token, amount)` | write | Owner 注入某周期某代币奖励池 |
| `setPeriodEndTimestamp(periodId, endTimestamp)` | write | （可选）Owner 设置某周期结束时间；新规则下领取不设 14 天作废，应得额度按周期锁定价值计算 |
| `claimReward(period, token)` | write | 领取某周期某代币应得奖励；应得额度 = 该周期锁定的「每贡献分价值」× 我的贡献分，代币数量按**该周期结算时**价格计算，可一次或分次领取。若启用按信誉分分配（`useReputationWeighting=true`），奖励按（贡献分 × 信誉分数/10000）分配 |
| `claimable(period, token, account)` | view | 查询可领取金额（过期返回 0） |
| `getContributionScore(period, account)` | view | 查询某周期贡献分 |
| `getPeriodTotalScore(period)` | view | 查询某周期总贡献分 |
| `setContributionScore(period, account, score)` | write | Owner 直接设置某地址贡献分（用于上线奖励等特殊分配） |
| `setReputationScore(account, score)` | write | Owner 设置节点信誉分数（0-10000，仅 owner） |
| `setReputationScores(accounts[], scores[])` | write | Owner 批量设置多个节点信誉分数（仅 owner） |
| `setReputationThreshold(threshold)` | write | Governance 设置信誉阈值（低于此值无法领取，0 表示不启用） |
| `setReputationWeighting(enabled)` | write | Governance 启用/禁用按信誉分加权分配（true：按信誉分分配；false：仅用阈值作为门槛） |
| `updateReputationAndRecalculateWeightedScore(account, newScore, periods[])` | write | Owner 更新信誉分数并重新计算相关周期的总加权贡献分 |
| `reputationScore(account)` | view | 查询节点信誉分数 |
| `reputationThreshold()` | view | 查询信誉阈值 |
| `useReputationWeighting()` | view | 查询是否启用按信誉分加权分配 |
| `isReputationQualified(account)` | view | 查询节点是否满足信誉要求 |
| `periodEndTimestamp(periodId)` | view | 某周期结束时间（0 表示未设置，不校验截止） |
| `CLAIM_DEADLINE_SECONDS` | constant | 14 days |

**事件**：`ProofSubmitted`, `PeriodRewardSet`, `PeriodEndTimestampSet`, `RewardClaimed`, `ReputationScoreSet`, `ReputationThresholdSet`, `ReputationWeightingEnabled`

**按信誉分分配**：如果 `useReputationWeighting = true`，奖励按照（贡献分 × 信誉分数/10000）进行分配。信誉分数越高，获得的奖励份额越多。详见 [信誉机制说明](./信誉机制说明.md)。

**上线奖励**：部署时通过 `setContributionScore("launch", developerAddress, 50000e18)` 给开发者地址设置 5 万贡献分（第一个周期）。**可自由流通**：该贡献分不受周期结束时间限制（周期未设置结束时间），可随时领取奖励（需先注入奖励池 `setPeriodReward`）。

**节点端提交**：使用 `go run ./cmd/submitproof -proof <JSON> -contract <addr> -rpc <url> -key <EVM 私钥>` 或环境变量 `REWARD_ETH_PRIVATE_KEY`。

### 2.7 Governance（治理）

按「最近 2 周有贡献」的地址活跃集投票，同意超过 50% 即通过。详见 [贡献奖励接口](./贡献奖励接口.md)、[治理部署与提案执行指南](./治理部署与提案执行指南.md)。

| 方法 | 类型 | 说明 |
|------|------|------|
| `createProposal(target, callData, merkleRoot, activeCount)` | write | 创建提案（merkleRoot/activeCount 由 merkletool 生成） |
| `vote(proposalId, support, proof)` | write | 投票（活跃集内地址，proof 由 merkletool -proof-for 生成） |
| `execute(proposalId)` | write | 执行（投票期结束且 yesCount > activeCount/2） |
| `getProposal(proposalId)` | view | 查询提案详情 |
| `proposalCount` | view | 提案总数 |
| `isInActiveSet(proposalId, account, proof)` | view | 校验 account 是否在活跃集内 |

**通过条件**：`yesCount > activeCount / 2`。同一 (target, callData) 执行后有 7 天冷却期。

### 2.8 TokenRegistry（上币）

| 方法 | 类型 | 说明 |
|------|------|------|
| `addToken(address)` | write | 添加可交易代币（仅 Governance 提案执行） |
| `removeToken(address)` | write | 移除代币 |
| `isListed(address)` | view | 是否已上币 |
| `listedTokens()` | view | 已上币列表 |

### 2.9 ChainConfig（流通链）

| 方法 | 类型 | 说明 |
|------|------|------|
| `addChain(uint256 chainId)` | write | 添加支持链（仅 Governance 提案执行） |
| `removeChain(uint256 chainId)` | write | 移除链 |
| `isSupported(uint256 chainId)` | view | 是否支持 |
| `supportedChainIds()` | view | 支持链列表 |

---

## 三、前端配置

### 3.1 配置文件位置

`frontend/src/config.ts`

### 3.2 配置项

```typescript
CHAIN_ID                 // 11155111 (Sepolia)
RPC_URL                  // RPC 节点地址
VAULT_ADDRESS            // Vault 合约
SETTLEMENT_ADDRESS       // Settlement
TOKEN0_ADDRESS           // Token A (TKA)
TOKEN1_ADDRESS           // Token B (TKB)
AMM_POOL_ADDRESS
CONTRIBUTOR_REWARD_ADDRESS
GOVERNANCE_ADDRESS       // 治理合约（部署后填入 config.ts）
TOKEN_REGISTRY_ADDRESS   // 上币配置（部署后填入）
CHAIN_CONFIG_ADDRESS     // 流通链配置（部署后填入）
VAULT_ABI, ERC20_ABI, AMM_ABI, GOVERNANCE_ABI
```

### 3.3 前端集成要点

- **钱包**：通过 `window.ethereum`（MetaMask 等）获取 `Eip1193Provider`，使用 ethers v6 的 `BrowserProvider`
- **网络**：连接后检查 `eth_chainId`，若非 Sepolia 则 `wallet_switchEthereumChain` 或 `wallet_addEthereumChain`
- **数量**：内部以 18 位小数 BigInt 传递（`amount * 1e18`），展示时除以 `1e18`

---

## 四、Phase 2 同步协议（规划）

详见 [Phase2-设计文档](./Phase2-设计文档.md)。以下为消息格式摘要：

### 4.1 历史成交同步

**请求**：`SyncTradesRequest`
```json
{ "since": 1707292800, "until": 1707379200, "limit": 100 }
```

**响应**：`SyncTradesResponse`
```json
{
  "trades": [
    {
      "tradeId": "0x...",
      "pair": "TKA/TKB",
      "price": "1.0",
      "amount": "100",
      "fee": "0.1",
      "timestamp": 1707292850,
      "txHash": "0x..."
    }
  ]
}
```

### 4.2 贡献证明

**ContributionProof**：
```json
{
  "nodeId": "0x...",
  "nodeType": "storage",
  "period": "2025-02-01_2025-02-07",
  "metrics": {
    "uptime": 0.95,
    "storageUsedGB": 10,
    "storageTotalGB": 100,
    "bytesRelayed": 1073741824
  },
  "signature": "0x...",
  "timestamp": 1707292850
}
```

---

## 五、附录

### 5.1 错误码（钱包/合约）

| 错误 | 说明 |
|------|------|
| 4001 | 用户拒绝（MetaMask 等） |
| CALL_EXCEPTION | 合约 revert（余额不足、授权不足等） |
| network/chain | 网络切换或 RPC 异常 |

### 5.2 参考

- [ethers.js v6](https://docs.ethers.org/v6/)
- [EIP-1193 Provider](https://eips.ethereum.org/EIPS/eip-1193)
- [Sepolia Faucet](https://sepoliafaucet.com/)

---

*本文档随合约与前端实现更新。*
