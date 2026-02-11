---
name: node-api
description: 节点 HTTP/WebSocket API、订单簿查询、下单、限流。修改 API 路径、请求格式或限流逻辑时，需同步前端 nodeClient、OrderBookSection、文档。Use when editing node API, rate limiting, or WebSocket endpoints.
---

# 节点 API

## 不可变约束（优化时勿破坏）

1. **API 监听**：config.api.listen（如 :8080），前端 VITE_P2P_API_URL、VITE_P2P_WS_URL。
2. **下单限流**：api.rate_limit_orders_per_minute 每 IP 每分钟上限，超限 429；支持 X-Forwarded-For。
3. **订单必签**：API 强制要求 EIP-712 签名并验签，拒收无效/过期订单。
4. **多节点**：VITE_NODE_API_URL 逗号分隔多 URL，前端依次尝试；P2P 多节点 fallback。

## 代码位置

| 组件 | 路径 |
|------|------|
| 节点 API | node/internal/api/ |
| 前端 | frontend/src/nodeClient.ts、OrderBookSection.tsx |
| 配置 | node/config.example.yaml、frontend/.env.example |

## 相关文档

- docs/API-接口说明.md
- docs/公开API文档.md
- docs/部署与使用说明.md §3.4

## 优化注意

- 改 API 路径或请求体需同步 nodeClient、SDK、文档。
- 限流参数勿放宽过度（Spam 防护）。
