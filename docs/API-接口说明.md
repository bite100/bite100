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
| Settlement | `0xDa9f738Cc8bF4a312473f1AAfF4929b367e22C85` |
| Token A (TKA) | `0x678195277dc8F84F787A4694DF42F3489eA757bf` |
| Token B (TKB) | `0x9Be241a0bF1C2827194333B57278d1676494333a` |
| AMMPool | `0x85F18604a8e3ca3C87A1373e4110Ed5C337677d4` |
| ContributorReward | `0x0d833c05E366e1D9D9c4eb6BBE356d9D49C4F8C7` |
| **Governance** | 部署后填入，见 [DEPLOY-SEPOLIA](../contracts/DEPLOY-SEPOLIA.md) |
| **TokenRegistry** | 部署后填入 |
| **ChainConfig** | 部署后填入 |

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
| `settleTrade(maker, taker, tokenIn, tokenOut, amountIn, amountOut)` | write | 结算链下撮合成交（仅 owner） |

**事件**：`TradeSettled`

**说明**：Phase 1 当前以 AMM 为主，Settlement 用于未来链下订单簿撮合后的结算；前端 DApp 直连 AMMPool 做 Swap。

### 2.4 FeeDistributor（手续费分配）

| 方法 | 类型 | 说明 |
|------|------|------|
| `receiveFee(address token, uint256 amount)` | write | 接收手续费（由 Settlement/AMM 调用） |
| `claim(address token)` | write | 领取应得份额 |
| `claimable(address token, address account)` | view | 查询可领取金额 |
| `setRecipients(address[] accounts, uint16[] shareBps)` | write | 设置分配对象与比例（仅 owner） |

**ABI（前端用）**：
```
function receiveFee(address token, uint256 amount)
function claim(address token)
function claimable(address token, address account) view returns (uint256)
```

### 2.5 AMMPool（AMM 交易池）

| 方法 | 类型 | 说明 |
|------|------|------|
| `token0()` | view | 代币 0 地址 |
| `token1()` | view | 代币 1 地址 |
| `reserve0()` | view | 池中 token0 储备量 |
| `reserve1()` | view | 池中 token1 储备量 |
| `getAmountOut(address tokenIn, uint256 amountIn)` | view | 预览 Swap 输出量 |
| `swap(address tokenIn, uint256 amountIn)` | write | 执行 Swap（0.05% 手续费） |
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

**手续费**：`feeBps = 5`（0.05%），从 swap 输入中扣除后转入 FeeDistributor。**可通过治理投票调整**（`setFeeBps` 经治理合约执行，如限 1～100 bps）。

#### 交易费率对照币安

| 项目 | 本协议（当前） | 币安现货 |
|------|----------------|----------|
| AMM / 即时成交 | **0.05%**（单边，swap 从输入扣） | Taker 约 **0.04%～0.1%**（吃单） |
| 挂单 / Maker | 暂无链下订单簿 | Maker 约 **0.08%～0.1%**（挂单） |
| 说明 | 链上 AMM 单池，feeBps 可治理投票调整 | 阶梯 + BNB 抵扣等可再降；VIP 更低 |

### 2.6 ContributorReward（贡献奖励，Phase 2 M4）

按周期收集贡献证明，按贡献分占比分配该周期奖励池。详见 [贡献奖励接口](./贡献奖励接口.md)。

| 方法 | 类型 | 说明 |
|------|------|------|
| `submitProof(period, uptime, storageUsedGB, storageTotalGB, bytesRelayed, nodeType, signature)` | write | 提交贡献证明（msg.sender 为领奖地址，signature 为 ECDSA 65 字节） |
| `setPeriodReward(period, token, amount)` | write | Owner 注入某周期某代币奖励池 |
| `claimReward(period, token)` | write | 领取某周期某代币应得奖励 |
| `claimable(period, token, account)` | view | 查询可领取金额 |
| `getContributionScore(period, account)` | view | 查询某周期贡献分 |
| `getPeriodTotalScore(period)` | view | 查询某周期总贡献分 |

**事件**：`ProofSubmitted`, `PeriodRewardSet`, `RewardClaimed`

**节点端提交**：使用 `go run ./cmd/submitproof -proof <JSON> -contract <addr> -rpc <url> -key <EVM 私钥>` 或环境变量 `REWARD_ETH_PRIVATE_KEY`。

### 2.7 Governance（治理）

按「最近 4 周有贡献」的地址活跃集投票，同意超过 50% 即通过。详见 [贡献奖励接口](./贡献奖励接口.md)、[治理部署与提案执行指南](./治理部署与提案执行指南.md)。

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
