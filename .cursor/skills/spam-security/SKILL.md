---
name: spam-security
description: 安全与防滥用：订单签名验证、Replay/过期防护、Relayer 防滥用、限流、信誉机制。修改安全逻辑时勿放宽验证或限流。Use when editing spam protection, signature verification, or relayer abuse prevention.
---

# 安全与防滥用

## 不可变约束（优化时勿破坏）

1. **订单签名**：前端与节点均验证 EIP-712，拒收无效签名。
2. **Replay/过期**：expiresAt < now 一律拒绝；API、存储、撮合入口统一检查。
3. **Relayer**：Settlement 白名单 isRelayer、maxGasReimbursePerTrade 单笔上限。
4. **限流**：api.rate_limit_orders_per_minute 每 IP，超限 429。
5. **信誉**：按信誉分分配奖励，无准入但有绑定限制（1 钱包 1–3 节点等），见信誉机制说明。

## 代码位置

| 组件 | 路径 |
|------|------|
| 签名验证 | frontend orderVerification、node internal/match/signature.go |
| 过期检查 | node storage、match、api |
| Relayer | contracts Settlement.sol |
| 限流 | node internal/api、relay/limiter.go |

## 相关文档

- docs/信誉机制说明.md、信誉分配示例.md
- docs/节点入网说明.md
- docs/功能增加与改进总结.md §三 可改进的痛点

## 优化注意

- 勿移除或弱化签名验证、过期检查、限流。
- 防 Sybil：绑定限制 + 声誉，治理可挑战。
