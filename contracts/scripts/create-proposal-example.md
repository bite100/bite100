# 治理提案：createProposal / vote / execute 示例

完成 Governance、TokenRegistry、ChainConfig 部署后，按以下步骤创建真实提案并走完投票与执行。

---

## 1. 准备活跃地址列表

从 ContributorReward 的 `ProofSubmitted` 事件或自有数据收集「最近 4 周有贡献」的去重地址，每行一个，保存为 `node/active-addresses.txt`：

```
0xYourAddress1...
0xYourAddress2...
```

---

## 2. 用 merkletool 生成 root 与 proof

```bash
cd node
go run ./cmd/merkletool -list active-addresses.txt
# 输出: merkleRoot: 0x...  activeCount: N

go run ./cmd/merkletool -list active-addresses.txt -proof-for 0x<投票者地址>
# 输出该地址的 proof 数组
```

---

## 3. 创建提案（以改 Settlement 费率为例）

将 `setFeeBps` 改为 8 (0.08%)：

```powershell
$rpc = "https://ethereum-sepolia.publicnode.com"
$gov = "0x..."      # Governance 合约地址
$settlement = "0xDa9f738Cc8bF4a312473f1AAfF4929b367e22C85"
$root = "0x..."     # merkletool 输出的 merkleRoot（32 字节 hex）
$activeCount = 5    # 活跃地址数量

# callData = Settlement.setFeeBps(uint16)
$calldata = (cast calldata "setFeeBps(uint16)" 8)

cast send $gov "createProposal(address,bytes,bytes32,uint256)" $settlement $calldata $root $activeCount --rpc-url $rpc --private-key $env:PRIVATE_KEY
```

输出中的 `ProposalCreated` 事件含 `proposalId`（从 0 开始）。

---

## 4. 投票

每个活跃地址调用 `vote(proposalId, support, proof)`，其中 `proof` 由 `merkletool -proof-for <该地址>` 得到。

```powershell
$proposalId = 0
$support = $true   # true=赞成, false=反对
$proof = "[\"0x...\",\"0x...\"]"   # merkletool 输出的 proof 数组，JSON 格式

cast send $gov "vote(uint256,bool,bytes32[])" $proposalId $support $proof --rpc-url $rpc --private-key $env:PRIVATE_KEY
```

**注意**：需用该投票者的私钥（换钱包或 `--private-key` 指向其私钥）。

---

## 5. 执行

投票期（7 天）结束后，且 `yesCount > activeCount/2`，任何人可执行：

```powershell
cast send $gov "execute(uint256)" $proposalId --rpc-url $rpc --private-key $env:PRIVATE_KEY
```

同一 (target, callData) 执行后有 **7 天冷却期** 才能再创建相同提案。

---

## 6. 其他提案示例

### 上币（addToken）

```powershell
$tokenRegistry = "0x..."   # TokenRegistry 地址
$tokenAddr = "0x..."       # 要添加的代币合约地址
$calldata = (cast calldata "addToken(address)" $tokenAddr)
cast send $gov "createProposal(address,bytes,bytes32,uint256)" $tokenRegistry $calldata $root $activeCount --rpc-url $rpc --private-key $env:PRIVATE_KEY
```

### 添加流通链（addChain）

```powershell
$chainConfig = "0x..."     # ChainConfig 地址
$chainId = 84532           # 如 Base Sepolia
$calldata = (cast calldata "addChain(uint256)" $chainId)
cast send $gov "createProposal(address,bytes,bytes32,uint256)" $chainConfig $calldata $root $activeCount --rpc-url $rpc --private-key $env:PRIVATE_KEY
```

---

## 7. 查询提案状态

```powershell
cast call $gov "getProposal(uint256)" $proposalId --rpc-url $rpc
# 返回: target, callData, activeCount, createdAt, votingEndsAt, yesCount, noCount, executed
```
