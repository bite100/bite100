# 治理提案与默克尔树工具使用说明

## 一、部署顺序（Sepolia 示例）

### 1. 部署 Governance 并绑定

确保已有 Settlement、AMMPool、ContributorReward 地址，然后：

```powershell
cd d:\P2P\contracts
$rpc = "https://ethereum-sepolia.publicnode.com"
$env:SETTLEMENT_ADDRESS = "0x..."      # 你的 Settlement 地址
$env:AMMPOOL_ADDRESS = "0x..."
$env:CONTRIBUTOR_REWARD_ADDRESS = "0x..."
forge script script/Deploy.s.sol:Deploy --sig "runGovernance()" --rpc-url $rpc --broadcast
# 输出 Governance <地址>
```

在 Settlement、AMMPool、ContributorReward 上已由脚本调用 `setGovernance(Governance地址)`。

### 2. 部署 TokenRegistry、ChainConfig

```powershell
$env:GOVERNANCE_ADDRESS = "0x..."   # 上一步输出的 Governance 地址
forge script script/Deploy.s.sol:Deploy --sig "runTokenRegistryAndChainConfig()" --rpc-url $rpc --broadcast
```

---

## 二、生成「最近 4 周活跃」地址列表

链下从 ContributorReward 的 `ProofSubmitted` 事件或自有数据库收集：过去 4 周内曾成功 `submitProof` 的**去重地址**，每行一个，保存为文本文件，例如 `active-addresses.txt`：

```
0x1234567890123456789012345678901234567890
0xabcdef...
```

---

## 三、默克尔树工具（merkletool）

### 生成 root 与 activeCount

```bash
cd node
go run ./cmd/merkletool -list active-addresses.txt
```

输出示例：

```
merkleRoot: 0xabcd...
activeCount: 5
```

### 为某地址生成 proof（用于 vote）

```bash
go run ./cmd/merkletool -list active-addresses.txt -proof-for 0x1234...
```

会多输出该地址的 proof 数组（hex），供链上 `vote(proposalId, true, proof)` 使用。

### 创建提案（示例：改 Settlement 费率）

用 cast 或前端调用 Governance：

- `target`: Settlement 地址  
- `callData`: `abi.encodeWithSelector(Settlement.setFeeBps.selector, uint16(8))`  
- `merkleRoot`: 上一步的 `merkleRoot`（0x 格式，32 字节）  
- `activeCount`: 上一步的 `activeCount`  

通过后需满足 **yesCount > activeCount / 2** 才能执行。同一 (target, callData) 执行后有 **7 天冷却期**。

### 投票

活跃集内地址调用 `vote(proposalId, support, proof)`，其中 `proof` 由 `merkletool -proof-for <该地址>` 得到。

### 执行

投票期结束且通过后，任何人可调用 `execute(proposalId)`。

---

## 四、上币 / 流通链提案示例

- **添加可交易代币**：target = TokenRegistry 地址，callData = `abi.encodeWithSelector(TokenRegistry.addToken.selector, tokenAddress)`  
- **添加流通链**：target = ChainConfig 地址，callData = `abi.encodeWithSelector(ChainConfig.addChain.selector, chainId)`

流程同上：链下生成活跃集 → merkletool 得到 root/activeCount 与各地址 proof → createProposal → 投票 → execute。
