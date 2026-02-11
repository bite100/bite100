---
name: vault-deposit-withdraw
description: 资金托管、Vault 合约、deposit/withdraw。修改 Vault 接口或余额逻辑时，需同步前端存提流程与 ABI。Use when editing Vault contract or deposit/withdraw flow.
---

# 资金托管（Vault）

## 不可变约束（优化时勿破坏）

1. **deposit**：用户需先 `approve(Vault, amount)`，再调用 `deposit(token, amount)`。
2. **withdraw**：仅能从自身 Vault 余额提取，不可超额。
3. **Settlement 划转**：Vault 仅允许 Settlement（或授权合约）从用户余额划转用于结算。
4. **balanceOf**：按 (token, user) 查询，前端依赖此做余额展示。

## 代码位置

| 组件 | 路径 |
|------|------|
| 合约 | contracts/src/Vault.sol |
| 前端 | frontend/src/（存提相关组件、utils） |

## 相关文档

- docs/API-接口说明.md §2.2
- docs/技术架构说明.md

## 优化注意

- 新增 token 类型或权限逻辑需同时更新前端授权与余额展示。
- 勿引入中心化托管逻辑（与去中心化原则一致）。

## 新手友好

- 存提流程：选代币→填数量→点存入/提取；首次授权用步骤引导，少提 Vault、approve 等技术概念。
