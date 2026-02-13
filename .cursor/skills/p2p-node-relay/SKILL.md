---
name: p2p-node-relay
description: P2P 节点、libp2p + 公共 bootstrap + DHT 发现（去中心化发现）、GossipSub、中继模式、WebSocket API。修改节点配置、Gossip 主题、relay 模式或 API 时，需同步 config.example、前端 P2P_CONFIG、文档。Use when editing node, relay mode, or libp2p config.
---

# P2P 节点与中继

## 节点发现方案

**libp2p + 公共 bootstrap + DHT 发现（去中心化发现）**：使用 libp2p 官方/社区公共 bootstrap 节点做首次连接引导，通过 Kademlia DHT 发现更多 peer，无需中心化注册。前端 `DEFAULT_BOOTSTRAP_LIST`、节点 `network.bootstrap` 可填公共或项目自建 multiaddr；`-connect` 可直连指定节点。

## 不可变约束（优化时勿破坏）

1. **relay 模式**：`--mode=relay` 轻量运行，仅 GossipSub + WebSocket API，无撮合/存储。
2. **领奖地址必填**：-reward-wallet 或 REWARD_WALLET 或 config.reward_wallet，未设置拒绝启动。
3. **Gossip 主题**：与 orderbook-match、Phase3 设计一致，勿随意增删。
4. **节点发现**：采用 libp2p + 公共 bootstrap + DHT 发现（去中心化发现）；network.bootstrap 多 addr，-connect 直连。
5. **数据保留**：统一两周，超期自动清理（概念文档、Phase2、技术架构说明）。

## 代码位置

| 组件 | 路径 |
|------|------|
| 节点主程序 | node/cmd/node、node/run.ps1 |
| libp2p host | node/internal/p2p/host.go |
| 配置 | node/config.example.yaml、config.relay.yaml |
| 前端连接 | frontend/src/config.ts P2P_CONFIG |

## 相关文档

- docs/Phase2-设计文档.md
- docs/节点发现与Bootstrap.md
- docs/Relay部署与Nginx.md

## 优化注意

- 改 Gossip 主题需同步 match、sync、前端 P2P 客户端。
- 已放弃 Electron 桌面版，以 PWA/浏览器为主。
