# 治理闭环（Sepolia）操作清单

> 目标：在 Sepolia 上完整走通 **创建提案 → 投票 → 投票期结束 → 执行**，验证 Governance → Settlement/AMMPool 的完整链路。  
> 详细说明见 [治理部署与提案执行指南](./治理部署与提案执行指南.md)。

---

## 前置条件

- [Foundry](https://book.getfoundry.sh)（`forge` / `cast` 可用）、[Go](https://go.dev/dl/)
- `contracts/.env` 中配置 `PRIVATE_KEY`（用于创建/投票/执行的同一钱包）
- 钱包有 Sepolia 测试 ETH（[水龙头](https://sepoliafaucet.com)）
- 前端已配置 Sepolia 治理地址（`frontend/src/config.ts` 中 SEPOLIA.GOVERNANCE 已为 `0x8F107ffaB0FC42E623AA69Bd10d8ad4cfbcE87BB`，一般无需改）

---

## 一、若尚未部署治理

```powershell
cd D:\P2P\contracts
.\scripts\deploy-governance.ps1
```

将终端输出的 **Governance 地址** 与 `docs/API-接口说明.md` 对照；若为新部署，需更新 `frontend/src/config.ts` 中 `SEPOLIA.GOVERNANCE`。当前 Sepolia 已部署地址见 [API-接口说明 §1.2](./API-接口说明.md#12-合约地址sepolia)。

---

## 二、当天可完成的步骤（创建 + 投票）

### 1. 准备活跃集与默克尔数据

把**用于投票的钱包地址**（建议即部署者地址）写入 `node/active-addresses.txt`，每行一个：

```
0x你的钱包地址
```

生成 root 与 proof：

```bash
cd D:\P2P\node
go run ./cmd/merkletool -list active-addresses.txt
```

记录输出的 **merkleRoot**（0x...）和 **activeCount**（单地址则为 1）。  
若需 proof（多地址时必填）：

```bash
go run ./cmd/merkletool -list active-addresses.txt -proof-for 0x你的钱包地址
```

### 2. 创建提案

**方式 A：前端**  
打开前端 → 治理卡片 →「创建提案（改 Settlement 费率）」：填写 feeBps（如 8）、activeCount、merkleRoot → 创建提案。记录提案 ID（首条一般为 0）。

**方式 B：命令行**

```powershell
$rpc = "https://ethereum-sepolia.publicnode.com"
$gov = "0x8F107ffaB0FC42E623AA69Bd10d8ad4cfbcE87BB"
$settlement = "0x493Da680973F6c222c89eeC02922E91F1D9404a0"
$root = "0x..."       # 步骤 1 的 merkleRoot
$activeCount = 1      # 步骤 1 的 activeCount

$calldata = (cast calldata "setFeeBps(uint16)" 8)
cast send $gov "createProposal(address,bytes,bytes32,uint256)" $settlement $calldata $root $activeCount --rpc-url $rpc --private-key $env:PRIVATE_KEY
```

从事件或前端提案列表确认 **proposalId**（通常为 0）。

### 3. 投票

**方式 A：前端**  
治理卡片 → 投票：提案 ID（如 0）、勾选赞成、proof 填 `[]`（单地址）或 merkletool 输出的 JSON 数组 → 投票。

**方式 B：命令行**

```powershell
$proposalId = 0
$support = $true
$proof = "[]"   # 单地址为空数组

cast send $gov "vote(uint256,bool,bytes32[])" $proposalId $support $proof --rpc-url $rpc --private-key $env:PRIVATE_KEY
```

通过条件：赞成票 > activeCount/2。单地址投 1 票赞成即通过。

### 4. 设提醒：7 天后执行

投票期为 **7 天**。在日历中设提醒：**7 天后**执行提案（见下一节）。  
期间可在前端治理卡片查看提案状态（投票中 → 可执行）。

---

## 三、7 天后：执行提案

投票期结束后，任选一种方式执行。

### 方式 A：前端

治理卡片 →「执行」→ 填写提案 ID（如 0）→ 点击「执行」。执行成功后，Settlement 的 `feeBps` 会变为提案中的值。

### 方式 B：脚本（推荐，一条命令）

```powershell
cd D:\P2P\contracts
.\scripts\execute-proposal.ps1 -ProposalId 0
```

脚本会从 `contracts/.env` 读取 `PRIVATE_KEY`，向 Sepolia 上的 Governance 调用 `execute(proposalId)`。可选：`-RpcUrl "https://..."` 指定 RPC。

### 方式 C：cast 手动

```powershell
$rpc = "https://ethereum-sepolia.publicnode.com"
$gov = "0x8F107ffaB0FC42E623AA69Bd10d8ad4cfbcE87BB"
$proposalId = 0

cast send $gov "execute(uint256)" $proposalId --rpc-url $rpc --private-key $env:PRIVATE_KEY
```

---

## 四、验证闭环

- 执行成功后，在 [Sepolia Etherscan](https://sepolia.etherscan.io) 查看 Governance 的 `ProposalExecuted` 事件。
- Settlement 的 `feeBps` 应已变为提案中的值（如 8）；可在区块浏览器查 Settlement 合约的 `feeBps()`，或通过后续前端/合约调用确认。

执行后，同一 (target, callData) 有 **7 天冷却期** 才能再创建相同提案。

---

## 文档与脚本索引

| 文档/脚本 | 用途 |
|-----------|------|
| [治理部署与提案执行指南](./治理部署与提案执行指南.md) | 完整步骤、多提案类型、故障排除 |
| [API-接口说明](./API-接口说明.md) | Sepolia 合约地址与接口 |
| contracts/scripts/deploy-governance.ps1 | 部署 Governance 与绑定 |
| contracts/scripts/execute-proposal.ps1 | 投票期结束后一键执行提案 |
