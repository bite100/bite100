---
name: frontend-ux
description: 前端主流程、钱包连接、链切换、错误提示、移动端适配。修改钱包连接、链配置或 UI 流程时，需同步 config/chains、ChainSwitcher、错误处理与 PWA 兼容。Use when editing frontend main flow, wallet connection, or chain switching.
---

# 前端主流程

## 不可变约束（优化时勿破坏）

1. **链配置**：frontend/src/config/chains.ts 与 contracts 地址一致；MAINNET、POLYGON、SEPOLIA 等。
2. **钱包**：支持 MetaMask 等 injected provider，连接前可 AddNetwork。
3. **移动端**：触控区域 ≥48px、安全区、输入框 16px 防缩放，与手机端开发指南一致。
4. **错误提示**：连接/交易失败时有明确提示与重试引导。
5. **PWA**：manifest、sw.js、main.tsx 注册，网络优先+离线回退。
6. **新手友好**：用户功能足够简单——交易、投票、提案等用大白话、最少步骤、最少术语；隐藏 Vault、Settlement、maker/taker 等技术概念；操作流程清晰（选币→填数量→点买卖）。

## 代码位置

| 组件 | 路径 |
|------|------|
| 主界面 | frontend/src/App.tsx |
| 链配置 | frontend/src/config/chains.ts、config.ts |
| 链切换 | frontend/src/components/ChainSwitcher.tsx |
| 添加网络 | frontend/src/components/AddNetworkButton.tsx |
| PWA | frontend/public/manifest.webmanifest、sw.js |

## 相关文档

- docs/手机端开发指南.md
- docs/部署与使用说明.md

## 优化注意

- 改 chains 配置需同步 RPC、合约地址、构建脚本（build:mainnet 等）。
- 勿恢复 Electron 桌面版（已放弃）。
