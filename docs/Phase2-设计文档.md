# P2P 去中心化交易所 - Phase 2 设计文档

> 版本：v0.1  
> 更新日期：2025-02-07  
> 关联文档：[概念设计文档](./概念设计文档.md)、[技术架构说明](./技术架构说明.md)

---

## 一、目标与范围

### 1.1 Phase 2 目标

在 Phase 1（链上托管 + AMM + Web 前端）基础上，建立 **节点网络**：用户可运行节点软件，贡献存储与带宽，参与数据同步，并获得可验证的贡献记录与奖励。

### 1.2 交付范围

| 交付物 | 说明 |
|--------|------|
| **节点软件** | 单一体可执行程序/安装包，支持 Windows / macOS / Linux，可配置为存储节点或中继节点 |
| **数据同步与存储** | 节点间订单簿/成交数据同步协议，存储节点持久化与两年保留策略 |
| **贡献度量与奖励** | 在线时长、存储量、转发量等指标采集与证明，与链上奖励合约对接（或预留接口） |

### 1.3 不包含（留待 Phase 3）

- 撮合节点与链下订单簿撮合（Phase 3）
- 完整经济模型与代币激励（Phase 3 细化）
- 手机端节点或移动 App（Phase 4）

---

## 二、节点软件设计

### 2.1 定位与形态

- **定位**：贡献者在本机运行的常驻进程，加入 P2P 网络，提供存储或中继能力。
- **形态**：CLI + 可选 TUI/Web 状态页；支持后台运行（systemd / launchd / Windows 服务可选）。
- **与 Phase 1 的关系**：前端 DApp 仍直接连链与合约交互；节点不替代前端，而是为未来的链下订单簿、数据查询提供基础设施。

### 2.2 节点类型（Phase 2 先实现两类）

| 类型 | 职责 | Phase 2 实现重点 |
|------|------|------------------|
| **存储节点** | 持久化订单簿快照、历史成交；响应同步请求；执行两年清理 | 本地 DB、同步协议服务端、清理任务 |
| **中继节点** | 转发 P2P 消息、维持网络连通性 | libp2p 中继、Gossip 订阅与转发、基础指标上报 |

### 2.3 软件架构

```
┌─────────────────────────────────────────────────────────────────┐
│  Config / CLI / (可选) Web 状态页                                 │
└─────────────────────────────────────────────────────────────────┘
                                    │
┌─────────────────────────────────────────────────────────────────┐
│  Node Core                                                        │
│  ├── Identity (密钥、NodeID)                                      │
│  ├── P2P Host (libp2p: DHT, GossipSub, Relay)                    │
│  ├── Sync Protocol (请求/响应 订单簿、成交)                         │
│  └── Metrics Collector (uptime, storage, bytes relayed)           │
└─────────────────────────────────────────────────────────────────┘
                                    │
┌──────────────────┬───────────────────────────────────────────────┐
│  存储节点模块     │  中继节点模块                                    │
│  ├── Local DB    │  ├── Topic 订阅与转发                            │
│  ├── Retention   │  └── 转发量统计                                  │
│  └── Sync Server │                                                  │
└──────────────────┴───────────────────────────────────────────────┘
                                    │
┌─────────────────────────────────────────────────────────────────┐
│  Blockchain Adapter (只读：读链上状态；可选：提交贡献证明)          │
└─────────────────────────────────────────────────────────────────┘
```

### 2.4 技术选型

| 项目 | 选型 | 说明 |
|------|------|------|
| 实现语言 | **Go** 或 **Rust** | 推荐 Go：libp2p 生态成熟，跨平台构建简单 |
| P2P 栈 | **libp2p** (go-libp2p / rust-libp2p) | 节点发现、DHT、GossipSub、Relay |
| 存储 | **SQLite** 或 **LevelDB** | 单节点足够，便于备份与迁移 |
| 配置 | YAML 或 TOML | 节点类型、Bootstrap 列表、链 RPC、数据目录 |

### 2.5 配置示例

```yaml
# config.yaml
node:
  type: storage   # storage | relay
  data_dir: ./data
  listen:
    - /ip4/0.0.0.0/tcp/4001
    - /ip4/0.0.0.0/udp/4001/quic-v1

network:
  bootstrap:
    - /ip4/1.2.3.4/tcp/4001/p2p/Qm...
  topics:
    - /p2p-exchange/sync/orderbook
    - /p2p-exchange/sync/trades

chain:
  rpc_url: https://sepolia.infura.io/v3/...
  chain_id: 11155111

storage:          # 仅存储节点
  retention_years: 2
  snapshot_interval_h: 24
```

### 2.6 目录结构（建议仓库布局）

```
node/                 # 或 p2p-node/
├── cmd/
│   └── node/
│       └── main.go
├── internal/
│   ├── config/
│   ├── p2p/          # libp2p host, gossip, dht
│   ├── sync/         # 同步协议：请求/响应
│   ├── storage/      # DB、保留策略、清理
│   ├── relay/        # 中继逻辑与统计
│   └── metrics/      # 贡献指标采集
├── config.example.yaml
├── go.mod
└── README.md
```

---

## 三、数据同步与存储节点

### 3.1 数据范围（Phase 2）

Phase 1 当前为 AMM，无链下订单簿。Phase 2 数据同步先以「可扩展结构」为主，为 Phase 3 订单簿做准备：

| 数据类型 | 说明 | Phase 2 存储/同步 |
|----------|------|--------------------|
| **订单簿快照** | 交易对、买卖盘深度 | 结构定义 + 同步协议；内容可先为占位或从链上 AMM 状态推导 |
| **历史成交** | 链上已结算的 Swap/成交 | 从链上事件或前端已有逻辑拉取，写入存储节点，用于同步与两年保留 |
| **贡献证明** | 节点自报的指标 | 见第四节 |

### 3.2 存储节点数据模型

与[技术架构说明](./技术架构说明.md)一致，仅做 Phase 2 可实现子集：

**成交记录（与链上一致）**

```json
{
  "tradeId": "0x...",
  "pair": "TKA/TKB",
  "takerOrderId": "0x...",
  "makerOrderId": "0x...",
  "price": "1.0",
  "amount": "100",
  "fee": "0.3",
  "timestamp": 1707292850,
  "txHash": "0x..."
}
```

**订单簿快照（为 Phase 3 预留）**

```json
{
  "pair": "TKA/TKB",
  "snapshotAt": 1707292800,
  "bids": [[ "price", "quantity" ], ...],
  "asks": [[ "price", "quantity" ], ...]
}
```

### 3.3 同步协议

- **传输**：基于 libp2p 的 Request-Response 或 GossipSub 的专用 Topic。
- **发现**：通过 DHT 或固定 Bootstrap 找到存储节点；可维护「存储节点列表」Topic 供查询。

**请求历史成交（拉取）**

- 消息类型：`SyncTradesRequest { since: unix_ts, until: unix_ts, limit: n }`
- 响应：`SyncTradesResponse { trades: [...] }`
- 约束：存储节点仅返回 `timestamp` 在两年内的数据；`since < now - 2years` 的请求视为 `since = now - 2years`。

**订单簿快照（Phase 2 可简化）**

- 可先定义消息格式与 Topic，内容由「占位」或「从链上 AMM 状态生成」填充，便于 Phase 3 直接接入真实订单簿。

### 3.4 数据保留与清理

- **保留期**：2 年（与概念设计、技术架构一致）。
- **清理**：存储节点定时任务（如每日）删除 `timestamp < now - 2years` 的成交与相关快照。
- **同步约束**：对外提供数据时一律按两年窗口过滤，不暴露超期数据。

---

## 四、贡献度量与奖励

### 4.1 Phase 2 度量指标

| 指标 | 适用节点 | 采集方式 | 周期 |
|------|----------|----------|------|
| **在线时长 (uptime)** | 全部 | 心跳 + 自报或抽查 | 每 5–10 分钟 |
| **存储容量 (storage)** | 存储节点 | 自报已用/总容量 | 每小时 |
| **转发量 (bytes relayed)** | 中继节点 | 统计转发字节数 | 每 10 分钟 |

### 4.2 贡献证明结构

与[技术架构说明](./技术架构说明.md)一致，扩展为可落地的字段：

```json
{
  "nodeId": "0x...",
  "nodeType": "storage",
  "period": "2025-02-01_2025-02-07",
  "metrics": {
    "uptime": 0.95,
    "storageUsedGB": 10,
    "storageTotalGB": 100,
    "bytesRelayed": 1073741824
  },
  "signature": "0x...",
  "timestamp": 1707292850
}
```

- `nodeId`：节点公钥或派生 ID。  
- `signature`：节点私钥对 `period + metrics` 的签名，供链上或审计方验证。

### 4.3 链上对接（Phase 2 可选）

- Phase 1 已有 **FeeDistributor**；技术架构中规划 **ContributorReward**。
- Phase 2 可二选一：
  - **方案 A**：实现 **ContributorReward** 合约（或扩展 FeeDistributor），节点定期提交贡献证明，链上验证签名后累计积分或发放奖励。
  - **方案 B**：链下收集证明、落库或公开 API，链上合约暂不实现，仅预留接口与事件格式，Phase 3 再接入经济模型。

推荐 Phase 2 先做 **链下证明收集 + 可验证结构**，再视资源实现 **ContributorReward** 或扩展 FeeDistributor。

### 4.4 防作弊要点

- **uptime**：由多节点或 Bootstrap 定期发起探测请求，结合自报做交叉验证。  
- **storage**：抽查：随机请求历史数据片段，验证节点是否真实持有并正确返回。  
- **bytes relayed**：基于 libp2p 的流量统计，可加签名或 nonce 防重放。

---

## 五、里程碑与任务拆解

### M1：节点骨架与 P2P 连通（约 4–6 周）

- [x] 新建 `node/` 目录，Go 工程初始化（[node/README.md](../node/README.md)）
- [x] 集成 libp2p：Host、 listen、connect 两节点互通
- [x] 配置文件加载（YAML）、DHT、GossipSub Topic 订阅
- [x] 节点身份：自动生成密钥，导出 NodeID
- [x] 验收：两节点启动后可通过 `-connect` 连接并维持连接

### M2：存储节点与数据层（约 4–6 周）

- [ ] 本地 DB：成交表、订单簿快照表（可为空表），按时间索引。
- [ ] 两年保留：定时清理任务，同步接口只返回两年内数据。
- [ ] 同步协议：`SyncTradesRequest/Response` 及 Topic 或 Request-Response 实现。
- [ ] （可选）从链上事件或现有接口拉取历史成交写入 DB，供同步使用。
- [ ] 验收：存储节点 A 写入数据，节点 B 通过同步协议拉取到一致结果。

### M3：中继与贡献指标（约 3–4 周）

- [ ] 中继节点：订阅指定 Topic，转发消息并统计 bytes relayed。
- [ ] 指标采集：uptime、storage（存储节点）、bytes relayed（中继节点）。
- [ ] 贡献证明：按周期生成签名结构，落盘或发送到指定 Topic/API。
- [ ] 验收：运行 24 小时，能产出符合格式的贡献证明。

### M4：链上对接与文档（约 2–4 周）

- [ ] 定义 ContributorReward 或扩展 FeeDistributor 的接口（提交证明、查询积分/奖励）。
- [ ] （可选）实现并部署合约，节点端提交证明的调用或脚本。
- [ ] 节点部署文档：安装、配置、Bootstrap 列表、防火墙建议。
- [ ] 更新[概念设计文档](./概念设计文档.md) Phase 2 勾选项与本文档链接。

---

## 六、风险与依赖

| 风险 | 缓解 |
|------|------|
| libp2p 学习曲线 | 先用 go-libp2p 官方示例打通 Host + DHT + GossipSub，再扩展协议 |
| NAT 穿透 | 使用 libp2p Relay + AutoNAT；必要时预留公网 Bootstrap 节点 |
| 贡献证明被伪造 | 签名校验、链上或中心化审计；Phase 2 可先链下审计 |
| 与 Phase 1 前端脱节 | 节点不替代前端；前端仍直连链；节点仅作为未来「订单簿/历史查询」的数据源，接口在 Phase 3 再统一 |

**依赖**：Phase 1 合约与前端稳定；Sepolia（或目标链）RPC 可用；Bootstrap 节点需至少 1–2 个可公开访问的节点（可项目方先部署）。

---

## 七、附录

### 7.1 参考

- [go-libp2p 示例](https://github.com/libp2p/go-libp2p/tree/master/examples)
- [GossipSub 规范](https://github.com/libp2p/specs/blob/master/pubsub/gossipsub/gossipsub-v1.0.md)
- [技术架构说明 - 存储节点数据模型](./技术架构说明.md#42-存储节点数据模型)

### 7.2 文档历史

| 版本 | 日期 | 说明 |
|------|------|------|
| v0.1 | 2025-02-07 | 初稿：节点软件、数据同步、贡献度量与里程碑 |

---

*Phase 2 设计随实现推进迭代更新。*
