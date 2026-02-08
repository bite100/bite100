# P2P 节点深度整合到交易撮合：步步指南

本指南说明如何将 P2P 节点与链下订单发现/撮合、链上结算整合为**混合模式**：off-chain 用于订单发现与初步匹配，on-chain 用于最终结算（Settlement 合约），实现真正的 P2P DEX。

---

## 1. 准备环境与运行基础节点

### 1.1 仓库与依赖

```bash
git clone https://github.com/P2P-P2P/p2p.git
cd p2p/node
go mod tidy
```

确保 `go.mod` 中已包含 `libp2p`、`libp2p-pubsub` 等依赖（当前项目已满足）。

### 1.2 运行单节点

**方式一：Go 直接运行**

```bash
cd node
go run ./cmd/node
```

**方式二：脚本（自动选择 Docker 或 Go）**

```powershell
# Windows
cd node
.\run.ps1
```

```bash
# Linux / macOS
cd node
./run.sh
```

启动后会输出 **Peer ID** 和多地址（如 `/ip4/0.0.0.0/tcp/4001/p2p/12D3KooW...`）。

### 1.3 多节点本地模拟

根目录使用 Docker Compose 启动多节点：

```bash
# 在仓库根目录
docker-compose up --scale node=3
```

可验证多节点互相发现与 GossipSub 连通性。

### 1.4 开启 HTTP API 与 WebSocket（前端用）

在 `node/config.yaml` 中设置（无则复制 `config.example.yaml`）：

```yaml
api:
  listen: ":8080"   # 前端连接 http://localhost:8080 与 ws://localhost:8080/ws
```

启用撮合与订单主题时，建议 `node.type: match`，并配置交易对与链上代币：

```yaml
node:
  type: match
match:
  pairs:
    TKA/TKB:
      token0: "0x..."   # base 代币合约地址
      token1: "0x..."   # quote 代币合约地址
```

---

## 2. P2P 协议与订单消息格式

### 2.1 现有实现（与本仓库一致）

项目已采用 **GossipSub + JSON**（非 protobuf），与 Phase3 设计文档、技术架构说明一致：

| 用途         | GossipSub 主题                     | 说明 |
|--------------|-------------------------------------|------|
| 新订单       | `/p2p-exchange/order/new`          | 订单广播 |
| 取消订单     | `/p2p-exchange/order/cancel`       | 撤单 |
| 成交通知     | `/p2p-exchange/trade/executed`      | 成交广播 |
| 订单簿同步   | `/p2p-exchange/sync/orderbook`      | 快照同步 |

常量定义在 `node/internal/sync/gossip_order.go`。

### 2.2 订单与成交结构（storage）

- **订单**：`node/internal/storage/orders.go` 中 `Order` 结构（含 `OrderID`、`Trader`、`Pair`、`Side`、`Price`、`Amount`、`Filled`、`Status`、`Signature`、`ExpiresAt` 等）。
- **成交**：`storage.Trade`（含 `TradeID`、`Maker`/`Taker`、`TokenIn`/`TokenOut`、`AmountIn`/`AmountOut`、`TxHash` 等），与 Settlement 合约参数对齐。

若需与“指南示例”中的 proto 对齐，可保留现有 `node/proto/order.proto` 用于其他用途；当前流水线使用 **JSON + storage 结构** 即可。

### 2.3 可选：Protobuf 生成（若将来统一为 proto）

```bash
# 若采用 proto 定义订单
protoc --go_out=. --go_opt=paths=source_relative proto/order.proto
```

当前节点与前端均使用 JSON，无需强制切到 proto。

---

## 3. 节点侧：订单广播与撮合逻辑

### 3.1 已有组件

- **OrderPublisher**（`internal/sync/order_publisher.go`）：加入上述主题，提供 `PublishOrder`、`PublishCancel`、`PublishTrade`、`PublishRaw`。
- **OrderSubscriber**（`internal/sync/order_subscriber.go`）：订阅 `order/new`、`order/cancel`、`trade/executed`，回调 `OrderHandler`。
- **Match.Engine**（`internal/match/engine.go`）：单主撮合引擎，按交易对维护订单簿，Price-Time 优先，`AddOrder` / `RemoveOrder` / `Match(taker)`，并产出 `storage.Trade` 列表。

### 3.2 整合流程（cmd/node 主程序）

主程序位于 **`node/cmd/node/main.go`**，负责串联：

1. **创建 Host + GossipSub**（`internal/p2p`）。
2. **创建 OrderPublisher**，并加入订单/撤单/成交主题。
3. **创建 Match.Engine**（若 `node.type: match`），从配置注入交易对与 token0/token1。
4. **实现 OrderHandler**：
   - **OnNewOrder**：将订单加入本地订单簿（`AddOrder`），再以该订单为 taker 调用 `Match(taker)`；若有成交，逐笔 `PublishTrade` 广播，并可选写入存储、通过 WebSocket 推给前端。
   - **OnCancelOrder**：`RemoveOrder` 从订单簿撤单。
   - **OnTradeExecuted**：若为存储节点，持久化成交记录。
5. **启动 OrderSubscriber**，将上述 Handler 注入。
6. **HTTP API**：`/api/order` 收到下单请求后，用 `PublishRaw(ctx, TopicOrderNew, data)` 广播（API 已按 topic + body 调用 Publish）。
7. **可选**：存储节点初始化 DB，撮合节点可仅内存订单簿。

这样即实现：**前端/API 下单 → 广播 → 各节点订阅 → 加入订单簿并撮合 → 成交广播 → 前端/链上结算**。

**链上结算**：成交广播后，由前端或节点作为 relayer 调用 Settlement 合约的 `settleTrade`，完成原子结算；合约已支持 `setRelayer` 与 8 参数 `settleTrade`，无需用户自付 gas。

### 3.3 安全要点

- 订单需带**签名**（如 EIP-712），节点在加入订单簿前应验证签名（见 `internal/match/signature.go` 等）。
- 防重放：依赖 `nonce`、`expiresAt`；链上结算时由 Settlement 合约再次校验。

---

## 4. 与 DEX 前端/合约整合

### 4.1 前端（React + ethers）

- **节点地址**：在 `frontend/src/config.ts` 中配置 `P2P_CONFIG.API_URL`、`P2P_CONFIG.WS_URL`（如 `http://localhost:8080`、`ws://localhost:8080/ws`）。
- **下单**：`frontend/src/services/orderService.ts` 已通过 `nodePost('/api/order', {...})` 提交订单；`nodeClient` 使用 `NODE_API_URL` 或 `NODE_API_URLS`。
- **WebSocket**：`frontend/src/services/wsClient.ts` 中 `P2PWebSocketClient` 连接 `ws://localhost:8080/ws`，订阅 `order_status`、`orderbook_update`、`trade`；收到 `trade` 后可触发链上结算。
- **链上结算**：在收到成交消息后，用 ethers 调用 Settlement 合约的 `settleTrade`（或 8 参数版本），由前端或 relayer 代付 gas；合约已支持 setRelayer。

### 4.2 合约侧

- **Settlement**：已支持 relayer 代付 gas（`setRelayer` + `settleTrade`）。节点或前端作为 relayer，匹配完成后收集签名并提交链上原子结算。
- **事件**：节点可用 go-ethereum 订阅 AMMPool 等事件，将链上流动性/成交同步到链下订单簿或展示。

### 4.3 Docker 整体部署

在 `docker-compose.yml` 中可把节点与前端一起编排，例如：

```yaml
services:
  node:
    build: ./node
    ports: ["4001:4001", "8080:8080"]
    environment:
      - CONFIG_PATH=/config.yaml
    volumes: ["./node/config.yaml:/config.yaml"]
  frontend:
    build: ./frontend
    depends_on: [node]
    environment:
      - VITE_P2P_WS_URL=ws://node:8080/ws
      - VITE_NODE_API_URL=http://node:8080
```

前端构建时注入 `VITE_P2P_WS_URL`、`VITE_NODE_API_URL`，运行期连接同一网络内的 node 服务。

---

## 5. 测试与扩展

- **本地测试**：启动 2～3 个节点（其中至少一个 `type: match` 且 `api.listen` 开启），前端连接该节点；用户 A/B 分别下单，观察 Gossip 日志与订单簿变化，匹配后应收到 `trade` 并可持续接链上结算。
- **性能**：GossipSub 适合广播与发现（1000+ peers）；若订单簿很大，可结合 DHT 或分片存储。
- **隐私与激励**：订单广播为明文可见，后续可考虑 zk-SNARK 等；节点运行者可获得 relayer fee（FeeDistributor）与贡献证明奖励（ContributorReward）。

---

## 文档与代码索引

| 文档/代码           | 路径/说明 |
|--------------------|-----------|
| 概念与 Phase       | docs/概念设计文档.md、docs/Phase3-设计文档.md |
| 技术架构与 Topic   | docs/技术架构说明.md |
| Gossip 主题与解析  | node/internal/sync/gossip_order.go、order_publisher.go、order_subscriber.go |
| 撮合引擎           | node/internal/match/engine.go |
| 节点配置           | node/config.example.yaml、internal/config/config.go |
| API 与 WebSocket   | node/internal/api/server.go、websocket.go |
| 前端 P2P 配置与下单 | frontend/src/config.ts、services/orderService.ts、services/wsClient.ts |

维护原则：功能或参数变更时，请同步更新本指南与上述设计文档（参见 docs/设计文档索引.md）。
