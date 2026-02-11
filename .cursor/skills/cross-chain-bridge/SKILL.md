---
name: cross-chain-bridge
description: 跨链桥接、LayerZero OApp。修改跨链合约或前端桥接界面时，需同步 OApp 配置、目标链、前端 CrossChainBridge 组件。Use when editing cross-chain bridge or LayerZero OApp.
---

# 跨链桥接

## 不可变约束（优化时勿破坏）

1. **LayerZero OApp**：合约实现 OApp 接口，endpoint、eid 与 LayerZero 文档一致。
2. **目标链**：ChainConfig 或前端 chains 中的目标链需与 OApp 配置匹配。
3. **跨链消息**：payload 结构、gas 估算与 LayerZero 要求一致。

## 代码位置

| 组件 | 路径 |
|------|------|
| 合约 | contracts/src/CrossChainBridge.sol |
| 前端 | frontend/src/components/CrossChainBridge.tsx |
| 链配置 | frontend/src/config/chains.ts |

## 相关文档

- docs/跨链功能设计.md、跨链功能实现指南.md
- docs/跨链桥接完整指南.md（已整合快速开始、实现、部署测试）

## 优化注意

- 新增目标链需部署 OApp、配置 eid、更新前端 chains。
- 勿引入非 LayerZero 的桥接逻辑除非有设计文档。
