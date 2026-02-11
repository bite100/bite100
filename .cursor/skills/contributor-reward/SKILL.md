---
name: contributor-reward
description: 贡献分、ContributorReward 合约、节点/流动性贡献证明、领取。修改证明格式、贡献分公式或领取逻辑时，需同步合约、节点 metrics、前端 UnifiedRewardClaim。Use when editing ContributorReward, contribution proof, or reward claim.
---

# 贡献分与奖励

## 不可变约束（优化时勿破坏）

1. **证明格式**：period + metrics + ECDSA 签名，链上 ecrecover 验证；与 node/internal/metrics/proof.go 一致。
2. **nodeType**：0=relay, 1=storage, 2=match, 3=liquidity。
3. **防重放**：同一 (msg.sender, period) 仅接受一次提交。
4. **贡献分价值**：每周期锁定「每贡献分价值」，领奖按发放时价值算（贡献奖励接口 §3.3）。
5. **领奖地址**：msg.sender 为领奖账户，或方案 B 的注册 claimAddress。

## 代码位置

| 组件 | 路径 |
|------|------|
| 合约 | contracts/src/ContributorReward.sol |
| 节点证明 | node/internal/metrics/proof.go、node/cmd/submitproof |
| 前端领取 | frontend/src/components/UnifiedRewardClaim.tsx |

## 相关文档

- docs/贡献奖励接口.md
- docs/流动性贡献分设计.md、实现指南.md

## 优化注意

- 改 payload 结构需同步节点 GenerateProof 与合约验签逻辑。
- 贡献分公式变更会影响历史周期，需文档化迁移策略。

## 新手友好

- 奖励领取：显示可领金额，一键「领取」，勿让用户选合约、选 period 等。
