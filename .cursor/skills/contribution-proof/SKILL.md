---
name: contribution-proof
description: 贡献证明格式、链下 metrics、链上 submitProof。修改证明 payload、签名逻辑或链上校验时，需同步 node metrics/proof、ContributorReward 合约。Use when editing contribution proof format or chain verification.
---

# 贡献证明

## 不可变约束（优化时勿破坏）

1. **payload**：period + metrics（uptime, storageUsedGB, storageTotalGB, bytesRelayed, tradesMatched, volumeMatched 等）的 JSON 序列化。
2. **链下**：节点 Ed25519 签名落盘；链上提交用 ECDSA，ecrecover == msg.sender（方案 A）。
3. **submitProof 入参**：period, uptime, storageUsedGB, storageTotalGB, bytesRelayed, nodeType, signature。
4. **submitProofEx**：撮合节点额外 tradesMatched, volumeMatched。
5. **submitLiquidityProof**：nodeType=3, liquidityAmount。

## 代码位置

| 组件 | 路径 |
|------|------|
| 节点证明生成 | node/internal/metrics/proof.go |
| 提交 | node/cmd/submitproof |
| 合约 | contracts/src/ContributorReward.sol |

## 相关文档

- docs/贡献奖励接口.md
- docs/Phase2-设计文档.md

## 优化注意

- 改 payload 结构需同步链上 keccak256(abi.encodePacked(...)) 与节点签名内容。
- 勿混用 Ed25519 链上验签（需预编译），方案 A 用 ECDSA。
