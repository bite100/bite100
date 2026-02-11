---
name: data-retention
description: 数据保留策略、节点存储清理。修改保留期或清理逻辑时，需与概念文档、Phase2、技术架构说明一致。Use when editing data retention, storage cleanup, or TTL logic.
---

# 数据保留

## 不可变约束（优化时勿破坏）

1. **统一两周**：节点存储默认两周，超期自动清理（概念文档、Phase2、技术架构说明）。
2. **概念文档**：电脑端最多 6 个月、手机端最多 1 个月（若与节点不同，以设计文档为准）。
3. **SyncTrades**：按 since/until/limit 返回保留范围内的数据。
4. **订单簿快照**：存储节点保留订单/成交在保留期内。

## 代码位置

| 组件 | 路径 |
|------|------|
| 节点存储 | node/internal/storage/ |
| SyncTrades | node/internal/sync/synctrades.go |
| 配置 | node/config.example.yaml |

## 相关文档

- docs/概念设计文档.md
- docs/Phase2-设计文档.md
- docs/技术架构说明.md

## 优化注意

- 改保留期需同步文档与配置默认值。
- 勿无限保留（与去中心化、存储成本原则一致）。
