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

## 四、更新 Sepolia 上已有合约费率为 0.05%

对已部署的 Settlement、AMMPool 调用 `setFeeBps(5)`（需 owner 私钥）：

```powershell
cd d:\P2P\contracts
# 确保 .env 中有 PRIVATE_KEY（部署者）
$rpc = if ($env:SEPOLIA_RPC_URL) { $env:SEPOLIA_RPC_URL } else { "https://ethereum-sepolia.publicnode.com" }
forge script script/Deploy.s.sol:Deploy --sig "runSetFeeBpsSepolia()" --rpc-url $rpc --broadcast
```

若地址不同，可设置 `SETTLEMENT_ADDRESS`、`AMMPOOL_ADDRESS` 环境变量。

## 五、部署治理合约（Governance）

部署 Governance 并绑定 Settlement、AMMPool、ContributorReward，使治理投票可调整 feeBps、freeFlowBps、reserveBps：

```powershell
$env:SETTLEMENT_ADDRESS = "0x..."   # 已部署的 Settlement 地址
$env:AMMPOOL_ADDRESS = "0x..."     # 已部署的 AMMPool 地址
$env:CONTRIBUTOR_REWARD_ADDRESS = "0x..."  # 已部署的 ContributorReward 地址
forge script script/Deploy.s.sol:Deploy --sig "runGovernance()" --rpc-url $rpc --broadcast
```

需使用各目标合约的 owner 私钥（`PRIVATE_KEY`）。

## 六、部署上币与流通链配置（TokenRegistry、ChainConfig）

部署后由 Governance 通过提案调用 `addToken`/`removeToken`、`addChain`/`removeChain`：

```powershell
$env:GOVERNANCE_ADDRESS = "0x..."   # 已部署的 Governance 地址
forge script script/Deploy.s.sol:Deploy --sig "runTokenRegistryAndChainConfig()" --rpc-url $rpc --broadcast
```

## 六.1、创建提案与投票流程（Governance）

1. **链下生成活跃集**：从 ContributorReward 的 `ProofSubmitted` 或自有数据收集「最近 2 周有贡献」的去重地址，每行一个写入 `active-addresses.txt`。
2. **生成默克尔 root 与 proof**（使用 node 仓库的 merkletool）：
   ```bash
   cd node
   go run ./cmd/merkletool -list active-addresses.txt
   # 得到 merkleRoot、activeCount
   go run ./cmd/merkletool -list active-addresses.txt -proof-for 0x<某投票者地址>
   # 得到该地址的 proof 数组
   ```
3. **创建提案**：调用 `Governance.createProposal(target, callData, merkleRoot, activeCount)`。例如改费率：target = Settlement 地址，callData = `abi.encodeWithSelector(Settlement.setFeeBps.selector, 8)`；上币：target = TokenRegistry，callData = `abi.encodeWithSelector(TokenRegistry.addToken.selector, tokenAddress)`。
4. **投票**：活跃集内地址调用 `vote(proposalId, support, proof)`，proof 由上一步 `-proof-for` 得到。通过条件：`yesCount > activeCount / 2`。
5. **执行**：投票期（7 天）结束后，任何人调用 `execute(proposalId)`。同一 (target, callData) 执行后有 **7 天冷却期** 才能再创建相同提案。

更详细说明与示例见：
- [node/scripts/governance-merkletool-example.md](../node/scripts/governance-merkletool-example.md)（merkletool 用法）
- [scripts/create-proposal-example.md](scripts/create-proposal-example.md)（cast 创建提案/投票/执行）

**一键部署**：运行 `scripts/deploy-governance.ps1` 可依次部署 ContributorReward（若未部署）、Governance、TokenRegistry、ChainConfig。

**若链上 Settlement/AMMPool 为旧版（无 governance）**：运行 `scripts/redeploy-settlement-amm.ps1` 重新部署并绑定；完成后更新 `frontend/src/config.ts` 与 `docs/API-接口说明.md` 中的 Settlement、AMMPool 地址。详见 [docs/部署与使用说明.md](../docs/部署与使用说明.md)。

## 七、仅部署 ContributorReward（贡献奖励合约）

若 Sepolia 上已有 Vault / FeeDistributor 等，只需部署 ContributorReward：

```powershell
cd d:\P2P\contracts
# 确保 .env 中有 PRIVATE_KEY
$rpc = if ($env:SEPOLIA_RPC_URL) { $env:SEPOLIA_RPC_URL } else { "https://ethereum-sepolia.publicnode.com" }
forge script script/Deploy.s.sol:Deploy --sig "runContributorReward()" --rpc-url $rpc --broadcast
```

部署成功后终端会输出 `ContributorReward <地址>`，将该地址补充到 [API-接口说明](../docs/API-接口说明.md) 的合约地址表中。

---

## 八、合约验证（可选）

在 `.env` 中配置对应网络的 API Key（如 `ETHERSCAN_API_KEY`）后，在部署命令末尾加 `--verify`：

- Base Sepolia：`BASESCAN_API_KEY`
- Arbitrum Sepolia：`ARBISCAN_API_KEY`
- Optimism Sepolia：`OPSCAN_API_KEY`
- Sepolia：`ETHERSCAN_API_KEY`

例如：

```powershell
forge script script/Deploy.s.sol:Deploy --rpc-url $rpc --broadcast --verify
```
