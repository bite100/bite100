---
name: order-signing
description: EIP-712 订单签名与验签。修改订单结构、domain 或 chainId 时，必须同时更新前端 orderSigning/orderVerification、节点 signature.go、SDK，否则订单无法验证。Use when editing order signing, EIP-712 domain, or order verification logic.
---

# 订单签名（EIP-712）

## 不可变约束（优化时勿破坏）

1. **domain 必须三处一致**：`frontend/src/services/orderSigning.ts`、`frontend/src/services/orderVerification.ts`、`node/internal/match/signature.go`。任一修改 domain.name/version/chainId 都需三处同步。
2. **Order 结构**：orderId, userAddress, tokenIn, tokenOut, amountIn, amountOut, price, timestamp, expiresAt。新增字段需三处同步，且影响已签订单兼容性。
3. **expiresAt**：节点与前端均拒绝已过期订单（Replay 防护）。

## 代码位置

| 组件 | 路径 |
|------|------|
| 前端签名 | frontend/src/services/orderSigning.ts |
| 前端验签 | frontend/src/services/orderVerification.ts |
| 节点验签 | node/internal/match/signature.go |
| SDK | sdk/js/src/index.ts、docs/P2P节点整合交易撮合指南.md |

## 相关文档

- docs/贡献奖励接口.md
- docs/API-接口说明.md
- docs/公开API文档.md

## 优化注意

- 改 domain 会令已有待撮合订单失效，需公告或迁移策略。
- CancelOrder 类型若存在，也需与 Order 同步维护。
