---
name: orderbook-match
description: 订单簿、撮合引擎、持久化、分片。修改订单结构、撮合算法、Gossip 主题或持久化逻辑时，需同步节点 match 模块、存储、前端 OrderBookSection。Use when editing orderbook, matching engine, or order persistence.
---

# 订单簿与撮合

## 不可变约束（优化时勿破坏）

1. **Price-Time 优先**：同价先到先得，撮合结果需确定性（多节点共识时一致）。
2. **Gossip 主题**：/p2p-exchange/order/new、/order/cancel、/trade/executed、/sync/orderbook 与 Phase3 设计一致。
3. **持久化**：open/partial 订单重启后从 store 恢复，跳过已过期订单。
4. **过期拒绝**：API、PersistOrderNew、AddOrder、OnNewOrder 统一拒绝 expiresAt < now。
5. **分片**：按交易对分片（方案 B），不同 pair 由不同撮合节点负责。

## 代码位置

| 组件 | 路径 |
|------|------|
| 撮合引擎 | node/internal/match/engine.go、router.go |
| 存储 | node/internal/storage/ |
| Gossip 发布/订阅 | node/internal/sync/gossip_order.go、order_subscriber.go |
| 前端 | frontend/src/OrderBookSection.tsx、OrderForm.tsx |

## 相关文档

- docs/Phase3-设计文档.md
- docs/多节点与共识设计.md、实现指南.md
- docs/技术架构说明.md

## 优化注意

- 改订单结构需同步 EIP-712 签名、存储 schema、前端类型。
- 撮合算法变更需保证多节点结果一致（方案 C BFT）。

## 新手友好

- 前端订单表单用大白话（如「以 X 价格买/卖 Y 数量」），隐藏 maker/taker、订单簿等术语；流程简洁：选币→填数量→点提交。
