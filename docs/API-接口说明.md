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
| `swap(address tokenIn, uint256 amountIn)` | write | 执行 Swap（0.3% 手续费） |
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

**手续费**：`feeBps = 30`（0.3%），从 swap 输入中扣除后转入 FeeDistributor。

---

## 三、前端配置

### 3.1 配置文件位置

`frontend/src/config.ts`

### 3.2 配置项

```typescript
CHAIN_ID       // 11155111 (Sepolia)
RPC_URL        // RPC 节点地址
VAULT_ADDRESS  // Vault 合约
TOKEN0_ADDRESS // Token A (TKA)
TOKEN1_ADDRESS // Token B (TKB)
AMM_POOL_ADDRESS
VAULT_ABI      // 上述 ABI 片段
ERC20_ABI
AMM_ABI
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
      "fee": "0.3",
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
