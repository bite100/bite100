---
name: settlement-chain
description: 链上结算、Settlement 合约、Relayer 代付 gas。修改 settleTrade 参数、relayer 白名单、gas 报销逻辑时，需同步合约、前端、节点与文档。Use when editing Settlement contract, relayer logic, or gas reimbursement.
---

# 链上结算（Settlement + Relayer）

## 不可变约束（优化时勿破坏）

1. **settleTrade 调用方**：仅 owner、单一 relayer 或 `isRelayer[addr]` 白名单可调用。
2. **gas 报销上限**：`maxGasReimbursePerTrade > 0` 时，单笔 gasReimburseIn+gasReimburseOut 不得超过该上限。
3. **链下撮合 → 链上结算**：订单在 P2P 撮合后，由 Settlement 做资产划转；不改变撮合结果，仅执行。
4. **手续费**：Settlement 可收取手续费并转 FeeDistributor，1% 自动给开发者。

## 代码位置

| 组件 | 路径 |
|------|------|
| 合约 | contracts/src/Settlement.sol |
| 前端调用 | frontend/src/*（通过 utils/contracts） |
| 节点提交 | node/internal/settlement/submit.go |

## 相关文档

- docs/API-接口说明.md §2.3
- docs/技术架构说明.md

## 优化注意

- 新增参数需更新 ABI、前端、节点调用链。
- Relayer 防滥用：白名单 + 单笔 gas 上限，勿放宽无限制。
