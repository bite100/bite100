# DAO 扩展设计文档

> 版本：v1.0  
> 更新日期：2025-02-08

---

## 一、概述

本文档描述 DAO 治理机制的扩展功能，旨在提供更完善的去中心化自治组织能力。

**核心原则**：不发行项目自己的治理代币，使用贡献分和信誉分进行治理。

---

## 二、当前实现

### 2.1 已实现功能

- ✅ **基础治理**：创建提案、投票、执行
- ✅ **Timelock**：执行延迟（2天）
- ✅ **多步骤提案**：支持在一个提案中执行多个操作
- ✅ **活跃集投票**：基于最近2周有贡献的地址
- ✅ **冷却期**：同一提案执行后7天内不可再创建
- ✅ **通过条件**：同意票数超过活跃集总数的50%

### 2.2 当前限制

- ❌ 提案缺少描述和元数据
- ❌ 不支持委托投票
- ❌ 不支持提案取消
- ❌ 不支持投票权重（基于贡献分）
- ❌ 缺少提案分类和模板

---

## 三、扩展功能设计

### 3.1 提案元数据

#### 3.1.1 功能描述

为提案添加描述、标题、分类等元数据，提高提案的可读性和可管理性。

#### 3.1.2 数据结构

```solidity
struct ProposalMetadata {
    string title;           // 提案标题
    string description;     // 提案描述（IPFS hash 或链上存储）
    string category;        // 提案分类（如 "参数调整"、"上币"、"合约升级"）
    string ipfsHash;        // IPFS 存储的详细描述（可选）
    address proposer;       // 提案创建者
    uint256 createdAt;      // 创建时间
}
```

#### 3.1.3 实现方案

- **链上存储**：短描述直接存储在合约中
- **IPFS 存储**：长描述存储在 IPFS，合约只存储 hash
- **事件日志**：通过事件记录元数据，便于前端展示

### 3.2 委托投票

#### 3.2.1 功能描述

允许地址将投票权委托给其他地址，支持更灵活的治理参与。

#### 3.2.2 数据结构

```solidity
mapping(address => address) public delegates; // 委托关系：委托人 -> 被委托人
mapping(address => address[]) public delegators; // 被委托人的委托人列表
```

#### 3.2.3 委托规则

- 委托可以是**单向委托**（A 委托给 B，B 可以代表 A 投票）
- 支持**撤销委托**
- 委托后，被委托人可以使用委托人的投票权
- 委托人自己仍可以投票（撤销委托）

### 3.3 提案取消

#### 3.3.1 功能描述

允许提案创建者或治理委员会取消提案（在投票期结束前）。

#### 3.3.2 取消条件

- **创建者取消**：提案创建者可以在投票期结束前取消
- **治理取消**：通过治理投票可以取消提案（需要新的提案）
- **自动取消**：投票期结束且未通过时自动标记为取消

#### 3.3.3 实现方案

```solidity
mapping(uint256 => bool) public cancelled; // 提案是否已取消

function cancelProposal(uint256 proposalId) external {
    Proposal storage p = proposals[proposalId];
    require(msg.sender == p.proposer || msg.sender == owner, "not authorized");
    require(block.timestamp < p.votingEndsAt, "voting ended");
    require(!p.executed, "already executed");
    cancelled[proposalId] = true;
    emit ProposalCancelled(proposalId);
}
```

### 3.4 投票权重

#### 3.4.1 功能描述

基于贡献分或信誉分计算投票权重，而非一人一票。

#### 3.4.2 权重计算

- **方案 A**：基于贡献分（从 ContributorReward 查询）
- **方案 B**：基于信誉分（从 ContributorReward 查询）
- **方案 C**：基于贡献分 × 信誉分

#### 3.4.3 实现方案

```solidity
function getVotingWeight(address voter, uint256 proposalId) public view returns (uint256) {
    // 查询贡献分
    uint256 contributionScore = contributorReward.getContributionScore(
        getCurrentPeriod(), 
        voter
    );
    // 查询信誉分
    uint256 reputation = contributorReward.reputationScore(voter);
    // 计算权重：贡献分 × (信誉分 / 10000)
    return (contributionScore * reputation) / 10000;
}
```

### 3.5 提案分类和模板

#### 3.5.1 功能描述

为提案添加分类，并提供常用提案模板，简化提案创建流程。

#### 3.5.2 提案分类

- **参数调整**：手续费、费率等参数调整
- **上币**：添加/移除可交易代币
- **合约升级**：合约升级或替换
- **资金管理**：金库资金使用
- **其他**：其他类型的提案

#### 3.5.3 提案模板

提供常用提案的模板，如：
- 调整手续费率
- 添加新代币
- 设置治理参数

### 3.6 治理参数调整

#### 3.6.1 功能描述

允许通过治理投票调整治理参数（投票期、通过阈值、Timelock 延迟等）。

#### 3.6.2 可调整参数

- `VOTING_PERIOD`：投票期（当前7天）
- `COOLDOWN_PERIOD`：冷却期（当前7天）
- `timelockDelay`：执行延迟（当前2天）
- `quorumThreshold`：通过阈值（当前50%）

### 3.7 紧急暂停机制

#### 3.7.1 功能描述

在紧急情况下，允许暂停治理功能或特定操作。

#### 3.7.2 实现方案

```solidity
bool public paused; // 是否暂停

modifier whenNotPaused() {
    require(!paused, "governance paused");
    _;
}

function pause() external onlyOwner {
    paused = true;
    emit GovernancePaused();
}

function unpause() external onlyOwner {
    paused = false;
    emit GovernanceUnpaused();
}
```

---

## 四、实施优先级

### 高优先级

1. **提案元数据**：提高提案可读性
2. **提案取消**：允许创建者取消错误提案
3. **投票权重**：基于贡献分的加权投票

### 中优先级

4. **委托投票**：提高治理参与灵活性
5. **提案分类**：便于管理和查找
6. **治理参数调整**：允许社区调整治理规则

### 低优先级

7. **紧急暂停**：紧急情况处理
8. **提案模板**：简化提案创建

---

## 五、实现方案

### 5.1 合约扩展

扩展 `Governance.sol` 合约，添加：
- 提案元数据存储
- 委托投票逻辑
- 提案取消功能
- 投票权重计算

### 5.2 前端扩展

扩展前端界面，添加：
- 提案描述和分类显示
- 委托投票界面
- 提案取消按钮
- 投票权重显示

### 5.3 集成 ContributorReward

集成 `ContributorReward` 合约，查询贡献分和信誉分用于投票权重计算。

---

## 六、相关文档

- [治理部署与提案执行指南](./治理部署与提案执行指南.md)
- [贡献奖励接口](./贡献奖励接口.md)
- [不发行代币说明](./不发行代币说明.md)

---

*本文档描述 DAO 治理机制的扩展功能设计，旨在提供更完善的去中心化自治组织能力。*
