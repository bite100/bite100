---
name: order-signing
description: EIP-712 订单签名与验签。修改订单结构、domain 或 chainId 时，必须同时更新前端 orderSigning/orderVerification、节点 signature.go、SDK，否则订单无法验证。Use when editing order signing, EIP-712 domain, or order verification logic.
---

# 订单签名（EIP-712）

> **唯一规范以 docs/eip712-order-spec.md 为准**（2026-11-07 定版，含 nonce 与验签结算规则）。

## 不可变约束（优化时勿破坏）

1. **domain 必须四处一致**：`frontend/src/services/orderSigningTypes.ts`（域定义）、`frontend/src/services/orderVerification.ts`、`node/internal/match/signature.go`、`contracts/src/Settlement.sol`。域为四字段 EIP712Domain(name, version, chainId, verifyingContract=Settlement 地址)；任一修改都需四处同步。
2. **Order 结构**：orderId, userAddress, tokenIn, tokenOut, amountIn, amountOut, price, timestamp, expiresAt, **nonce**（链上结算 nonce，下单时读 Settlement.getCurrentNonce）。字段顺序即编码顺序；改动需四处同步，且影响已签订单兼容性。
3. **amountOut 公式**：amountOut = amountIn * price / 1e18（price 为 1e18 定点），三方统一。
4. **expiresAt**：节点与前端均拒绝已过期订单（Replay 防护）；合约结算时同样校验。
5. **结算验签**：Settlement.settleTrade/批量入口对 Fill 内双方签名订单逐笔验签、按 digest 累计记账防超额重放、消耗 nonce；改结算接口须同步前端 settlementService 与节点 internal/settlement。

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
