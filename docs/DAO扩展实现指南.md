# DAO 扩展实现指南

> 版本：v1.0  
> 更新日期：2025-02-08

---

## 一、概述

本文档说明如何使用 DAO 扩展功能，包括提案元数据、取消机制、委托投票等。

---

## 二、核心功能

### 2.1 提案元数据

#### 功能说明

为提案添加标题、描述、分类等元数据，提高提案的可读性和可管理性。

#### 使用方法

**创建带元数据的提案**：

```solidity
// 单步骤提案
uint256 proposalId = governanceExtended.createProposalWithMetadata(
    target,
    callData,
    merkleRoot,
    activeCount,
    "调整手续费率",                    // title
    "将手续费率从 0.01% 调整为 0.02%", // description
    "参数调整"                         // category
);

// 多步骤提案
uint256 proposalId = governanceExtended.createMultiStepProposalWithMetadata(
    targets,
    callDataArray,
    merkleRoot,
    activeCount,
    "批量参数调整",                    // title
    "同时调整手续费率和储备比例",      // description
    "参数调整"                         // category
);
```

**使用 IPFS 存储详细描述**：

```solidity
uint256 proposalId = governanceExtended.createProposalWithIPFS(
    target,
    callData,
    merkleRoot,
    activeCount,
    "添加新代币",                      // title
    "QmXxxx...",                      // IPFS hash
    "上币"                             // category
);
```

**查询提案元数据**：

```solidity
(
    string memory title,
    string memory description,
    string memory category,
    string memory ipfsHash,
    address proposer
) = governanceExtended.getProposalMetadata(proposalId);
```

#### 提案分类

- `"参数调整"`：手续费、费率等参数调整
- `"上币"`：添加/移除可交易代币
- `"合约升级"`：合约升级或替换
- `"资金管理"`：金库资金使用
- `"其他"`：其他类型的提案

### 2.2 提案取消

#### 功能说明

允许提案创建者或 owner 在投票期结束前取消提案。

#### 使用方法

```solidity
// 取消提案（仅创建者或 owner）
governanceExtended.cancelProposal(proposalId);
```

**取消条件**：
- 必须是提案创建者或 owner
- 投票期尚未结束
- 提案尚未执行
- 提案尚未被取消

**取消后**：
- 提案标记为已取消
- 无法继续投票
- 无法执行

### 2.3 委托投票

#### 功能说明

允许地址将投票权委托给其他地址，支持更灵活的治理参与。

#### 使用方法

**委托投票权**：

```solidity
// 将投票权委托给其他地址
governanceExtended.delegate(delegateeAddress);
```

**撤销委托**：

```solidity
// 撤销委托，恢复自己的投票权
governanceExtended.undelegate();
```

**查询委托关系**：

```solidity
// 查询自己的被委托人
address delegatee = governanceExtended.delegates(myAddress);

// 查询某个被委托人的所有委托人
address[] memory delegators = governanceExtended.getDelegators(delegateeAddress);
```

**委托规则**：
- 委托是单向的（A 委托给 B，B 可以代表 A 投票）
- 可以随时撤销委托
- 委托后，被委托人可以使用委托人的投票权
- 委托人自己仍可以投票（撤销委托后）

### 2.4 投票权重

#### 功能说明

基于贡献分和信誉分计算投票权重，而非一人一票。

#### 权重计算

权重 = 贡献分 × (信誉分 / 10000)

- **贡献分**：从 `ContributorReward` 合约查询
- **信誉分**：从 `ContributorReward` 合约查询（范围 0-10000）
- **如果信誉分为 0**：使用贡献分作为权重

#### 使用方法

**带权重的投票**：

```solidity
// 使用权重投票（自动计算权重）
governanceExtended.voteWithWeight(proposalId, true, proof);
```

**查询投票权重**：

```solidity
uint256 weight = governanceExtended.getVotingWeight(voterAddress, proposalId);
```

---

## 三、部署和使用

### 3.1 部署 GovernanceExtended

```solidity
// 部署时需要传入 ContributorReward 合约地址
GovernanceExtended governanceExtended = new GovernanceExtended(contributorRewardAddress);
```

### 3.2 设置 ContributorReward

如果部署时未设置，可以通过 owner 设置：

```solidity
governanceExtended.setContributorReward(contributorRewardAddress);
```

### 3.3 迁移现有 Governance

如果需要从现有 `Governance` 合约迁移到 `GovernanceExtended`：

1. 部署 `GovernanceExtended`
2. 将现有提案的执行权限转移到新合约
3. 更新前端配置

---

## 四、前端集成

### 4.1 显示提案元数据

```typescript
// 查询提案元数据
const metadata = await governanceExtended.getProposalMetadata(proposalId);
console.log('标题:', metadata.title);
console.log('描述:', metadata.description);
console.log('分类:', metadata.category);
console.log('IPFS:', metadata.ipfsHash);
```

### 4.2 提案取消按钮

```typescript
// 检查是否可以取消
const proposal = await governanceExtended.getProposal(proposalId);
const metadata = await governanceExtended.getProposalMetadata(proposalId);
const isCancelled = await governanceExtended.cancelled(proposalId);

if (!isCancelled && 
    proposal.votingEndsAt * 1000 > Date.now() && 
    metadata.proposer.toLowerCase() === account.toLowerCase()) {
    // 显示取消按钮
}
```

### 4.3 委托投票界面

```typescript
// 查询当前委托
const delegatee = await governanceExtended.delegates(account);

// 委托投票权
await governanceExtended.delegate(delegateeAddress);

// 撤销委托
await governanceExtended.undelegate();
```

### 4.4 显示投票权重

```typescript
// 查询投票权重
const weight = await governanceExtended.getVotingWeight(account, proposalId);
console.log('投票权重:', weight.toString());
```

---

## 五、最佳实践

### 5.1 提案创建

- **使用描述性标题**：清晰说明提案内容
- **选择合适的分类**：便于管理和查找
- **提供详细描述**：使用 IPFS 存储长描述
- **验证提案内容**：创建前仔细检查 target 和 callData

### 5.2 委托投票

- **选择可信的委托人**：委托给有良好治理记录的地址
- **定期审查委托**：确保委托人代表你的利益
- **参与重要提案**：对于重要提案，考虑撤销委托自己投票

### 5.3 提案取消

- **及时取消错误提案**：发现错误后立即取消
- **说明取消原因**：通过链下渠道说明取消原因

---

## 六、相关文档

- [DAO扩展设计](./DAO扩展设计.md)
- [治理部署与提案执行指南](./治理部署与提案执行指南.md)
- [贡献奖励接口](./贡献奖励接口.md)
- [不发行代币说明](./不发行代币说明.md)

---

*本文档说明 DAO 扩展功能的使用方法，帮助用户更好地参与治理。*
