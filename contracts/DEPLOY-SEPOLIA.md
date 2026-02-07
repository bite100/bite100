# 部署到测试网（推荐：Gas 最低的 Base Sepolia）

## 网络与 Gas 对比

| 网络 | 类型 | Gas 费用 | 推荐 |
|------|------|----------|------|
| **Base Sepolia** | L2 测试网 | **最低**（约 0.0001–0.001 ETH） | ✅ 首选 |
| Arbitrum Sepolia | L2 测试网 | 很低 | 备选 |
| Optimism Sepolia | L2 测试网 | 很低 | 备选 |
| Sepolia (Ethereum L1) | L1 测试网 | 较高（约 0.006+ ETH） | 备选 |

**建议**：优先使用 **Base Sepolia**，部署同一套合约的 gas 费通常比 Sepolia 低一个数量级以上。

---

## 一、部署到 Base Sepolia（Gas 最低）

### 1. 获取 Base Sepolia 测试币

部署约需 **0.001 ETH** 左右（视 gas 价格波动）。水龙头：

| 水龙头 | 说明 |
|--------|------|
| [Base Sepolia 官方水龙头](https://www.coinbase.com/faucets/base-sepolia-faucet) | Coinbase 账号，每日可领 |
| [Alchemy Base Sepolia](https://sepoliafaucet.com/) | 选 Base Sepolia 网络后领水 |

领到后可在 [Base Sepolia 区块浏览器](https://sepolia.basescan.org/) 用你的地址查余额。

### 2. 配置环境变量

在 `contracts` 目录下：

```powershell
cd d:\P2P\contracts
copy .env.example .env
# 编辑 .env，至少填入：
# PRIVATE_KEY=0x你的钱包私钥
# 可选：BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
```

### 3. 执行部署（Base Sepolia）

**仅部署核心合约：**

```powershell
$env:Path = "$env:USERPROFILE\.foundry\versions\stable;$env:Path"
if (Test-Path .env) { Get-Content .env | ForEach-Object { if ($_ -match '^\s*([^#=]+)=(.+)$') { $k = $Matches[1].Trim(); $v = $Matches[2].Trim(); if ($k -and $v) { [Environment]::SetEnvironmentVariable($k, $v, 'Process') } } } }
$rpc = if ($env:BASE_SEPOLIA_RPC_URL) { $env:BASE_SEPOLIA_RPC_URL } else { "https://sepolia.base.org" }
forge script script/Deploy.s.sol:Deploy --rpc-url $rpc --broadcast
```

**部署核心合约 + Mock 代币 + AMM 池：**

```powershell
forge script script/Deploy.s.sol:Deploy --sig "runWithAmmAndMocks()" --rpc-url $rpc --broadcast
```

部署成功后，合约地址会打印在终端，交易记录在 `broadcast/Deploy.s.sol/84532/`（Base Sepolia chainId 为 84532）。

---

## 二、其他低 Gas 测试网（可选）

### Arbitrum Sepolia

- RPC：`https://sepolia-rollup.arbitrum.io/rpc`
- 水龙头：[Arbitrum Sepolia Faucet](https://faucet.quicknode.com/arbitrum/sepolia) 等
- 部署：将上面命令中的 `$rpc` 改为该 RPC 即可。

### Optimism Sepolia

- RPC：`https://sepolia.optimism.io`
- 水龙头：[Optimism Sepolia Faucet](https://app.optimism.io/faucet) 等
- 部署：将 `$rpc` 改为该 RPC 即可。

---

## 三、Sepolia（Ethereum L1，Gas 较高）

若需部署到 Sepolia：

- RPC：`https://ethereum-sepolia.publicnode.com`
- 部署约需 **0.006–0.007 ETH**；水龙头见 [sepoliafaucet.com](https://sepoliafaucet.com/) 等。
- 命令同上，仅将 `$rpc` 设为 Sepolia 的 RPC，或使用 `$env:SEPOLIA_RPC_URL`。

---

## 四、合约验证（可选）

在 `.env` 中配置对应网络的 API Key 后，在部署命令末尾加 `--verify`：

- Base Sepolia：`BASESCAN_API_KEY`
- Arbitrum Sepolia：`ARBISCAN_API_KEY`
- Optimism Sepolia：`OPSCAN_API_KEY`
- Sepolia：`ETHERSCAN_API_KEY`

例如：

```powershell
forge script script/Deploy.s.sol:Deploy --rpc-url $rpc --broadcast --verify
```
