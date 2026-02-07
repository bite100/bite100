# P2P 节点

Phase 2 节点软件：libp2p 网络接入，支持存储节点与中继节点。

## M1：两节点连通

### 运行方式（任选其一，无需额外安装）

**方式一：Docker（推荐，无需 Go）**

```bash
cd node
docker build -t p2p-node .
docker run -it --rm -p 4001:4001 p2p-node
```

**方式二：一键脚本（自动选 Docker 或 Go）**

```powershell
# Windows
cd node
.\run.ps1
```

```bash
# Linux / macOS
cd node
chmod +x run.sh && ./run.sh
```

**方式三：Go 源码**

```bash
cd node
go mod tidy   # 首次运行需拉取依赖
go run ./cmd/node
```

**终端 1（节点 A，监听）**：任选上面一种方式启动。

输出示例：
```
节点启动 | PeerID: Qm...
  监听: /ip4/0.0.0.0/tcp/4001/p2p/Qm...
```

**终端 2（节点 B，连接）**：

把**节点 A** 输出里整行「监听」地址复制下来，把其中的 `0.0.0.0` 改成 `127.0.0.1`（本机时）。**同机测试**时节点 B 必须加 `-port 4002` 避免端口冲突。例如节点 A 显示：

```
监听: /ip4/127.0.0.1/tcp/4001/p2p/12D3KooWAbc123...
```

则节点 B 执行（把下面的地址换成你复制的、并把 0.0.0.0→127.0.0.1）：

```powershell
.\run.ps1 -port 4002 -connect /ip4/127.0.0.1/tcp/4001/p2p/12D3KooWAbc123...
```

**注意**：`12D3KooWAbc123...` 要换成节点 A 实际打印的 PeerID，不要写成字面量 `<PeerID>`。

### 验收

- 节点 A 日志出现 `已连接对等节点: <PeerID>`
- 节点 B 日志出现 `已连接到远程节点，当前连接数: 1`
- 按 Ctrl+C 可正常退出

### 测试 GossipSub 消息

两节点连通后，可用 `-publishTopic` 和 `-publishMsg` 向 topic 发送消息，另一节点会打印收到的内容。

**终端 1（节点 A）**：`.\run.ps1`，记录输出的 PeerID 和地址。

**终端 2（节点 B）**：连接节点 A 并发送一条测试消息：

```powershell
.\run.ps1 -port 4002 -connect /ip4/127.0.0.1/tcp/4001/p2p/<节点A的PeerID> -publishTopic /p2p-exchange/sync/trades -publishMsg "hello from B"
```

预期：节点 A 打印 `[/p2p-exchange/sync/trades] 来自 <B的PeerID>: 13 bytes`。

### M2：存储节点与 SyncTrades（P2P 下载）

**P2P 下载模型**：有数据的节点作为热点，无数据的节点主动请求并下载，下载完成后作为热点打开，供其他节点拉取。

- **热点（有数据）**：存储节点或已完成下载的节点，注册 SyncTrades 协议，响应其他节点的拉取请求。
- **拉取方（无数据）**：使用 `-sync-from <PeerID>` 向热点请求并下载，数据写入本地（storage 节点写主 DB，relay 写 `data_dir_downloads/`）。
- **下载完成后**：拉取方自动注册 SyncTrades 并保持运行，作为热点供其他节点下载，形成 P2P 分发网。

**存储节点（初始热点）**：`config.yaml` 中 `node.type: storage`，会初始化本地 SQLite，并启动保留期定时清理。**电脑端** 6 个月、**手机端** 1 个月。

**SyncTrades 协议**：存储节点注册 `/p2p-exchange/sync/trades/1.0.0`，按 `since`/`until`/`limit` 返回本节点已保留范围内的数据（电脑端最多 6 个月，手机端最多 1 个月）。

**M2 验收（存储节点写数据 → 另一节点拉取一致）**：

1. **终端 1（节点 A，存储节点）**  
   - 复制 `config.example.yaml` 为 `config.yaml`，将 `node.type` 改为 `storage`。  
   - 启动并写入 5 条测试成交：
   ```powershell
   .\run.ps1 -seedTrades
   ```
   - 记下输出中的 **PeerID** 和 **监听地址**（例如 `/ip4/0.0.0.0/tcp/4001/p2p/12D3KooW...`）。  
   - 日志中应出现：`[seed] 已插入 5 条测试成交，用于 M2 验收`。

2. **终端 2（节点 B，拉取方）**  
   - 将下面命令里的 `<节点A的PeerID>` 和地址中的 `0.0.0.0`→`127.0.0.1` 换成终端 1 的实际值：
   ```powershell
   .\run.ps1 -port 4002 -connect /ip4/127.0.0.1/tcp/4001/p2p/<节点A的PeerID> -syncFrom <节点A的PeerID>
   ```

3. **验收**  
   - 节点 B 应打印：`从 <PeerID> 拉取到 5 条成交`、`已下载并保存 5 条成交至本地`，且 5 条记录含 `m2-acceptance-test-0`～`m2-acceptance-test-4`、pair `TKA/TKB`、txHash `0xseed0`～`0xseed4`。  
   - 拉取的数据写入本地 DB（storage 节点写入主 DB，relay 写入 `data_sync_client_downloads/`），完成 P2P 下载。

**（可选）从链上拉取**：在 `config.yaml` 配置 `chain.rpc_url`、`chain.amm_pool`、`chain.token0`、`chain.token1`，存储节点启动时会自动拉取 AMM Swap 事件写入 DB。

### M3：中继与贡献证明

- **中继节点**（`node.type: relay`）：订阅配置中的 topics，收到消息时统计转发字节数（bytes relayed）。
- **指标**：全部节点采集 uptime；存储节点额外采集 storage（已用/总容量，总容量当前可为 0）；中继节点额外采集 bytes relayed。
- **贡献证明**：按配置周期（默认 7 天，可配 `metrics.proof_period_days`）在周期结束后生成带签名的证明 JSON，写入 `metrics.proof_output_dir`（默认 `data_dir/proofs`）。证明结构含 `nodeId`、`nodeType`、`period`、`metrics`（uptime、storage、bytesRelayed 等）、`signature`、`timestamp`。

**M3 验收（连续运行约 24 小时产出贡献证明）**：

1. 将 `config.yaml` 中 `metrics.proof_period_days` 设为 `1`（以便 1 天内产出证明）。
2. 启动节点（relay 或 storage 均可），保持运行超过 24 小时，且跨越一个 UTC 自然日（例如从周一 10:00 运行到周二 10:00 之后）。
3. 检查证明目录（默认 `./data/proofs` 或 `node.type: storage` 时的 `./data/proofs`）：应出现 `proof_YYYY-MM-DD_YYYY-MM-DD.json`，内容为符合格式的贡献证明（含 `nodeId`、`nodeType`、`period`、`metrics`、`signature`、`timestamp`）。

**链上提交证明（可选）**：若已部署 `ContributorReward` 合约，可用 `submitproof` 将本地证明提交上链并参与按周期分配。需配置 EVM 私钥（领奖地址对应）。示例：
```bash
go run ./cmd/submitproof -proof ./data/proofs/proof_2025-02-01_2025-02-08.json -contract <ContributorReward 地址> -rpc https://sepolia.infura.io/... -key <EVM 私钥十六进制>
```
也可使用环境变量 `REWARD_ETH_PRIVATE_KEY` 替代 `-key`。详见 [贡献奖励接口](../docs/贡献奖励接口.md)。

### 配置

- 可选：复制 `config.example.yaml` 为 `config.yaml`，按需修改。
- 支持项：`node.type`（storage|relay）、`node.data_dir`、`node.listen`；`network.bootstrap`、`network.topics`；`storage.retention_months`（电脑端 6、手机端 1）；`metrics.proof_period_days`、`metrics.proof_output_dir`（M3）；`chain.*`（可选）。
- 启动时加 `-config <path>` 指定配置文件。
- DHT：若配置了 `network.bootstrap`，启动时会连接并加入 DHT。

## 项目结构

```
node/
├── cmd/
│   ├── node/        # 节点入口
│   └── submitproof/ # 链上提交贡献证明（可选）
├── internal/
│   ├── config/      # 配置加载
│   ├── p2p/         # libp2p host, DHT, GossipSub
│   ├── storage/     # SQLite 成交表、订单簿快照、两年保留
│   ├── sync/        # SyncTrades 协议
│   ├── metrics/     # uptime、storage、bytes relayed、贡献证明
│   ├── reward/      # 贡献证明链上提交（ECDSA 签名与 calldata）
│   └── chain/       # 可选：链上 Swap 事件拉取
├── config.example.yaml
├── go.mod
└── README.md
```

## 参考

- [Phase2 设计文档](../docs/Phase2-设计文档.md)
- [go-libp2p](https://github.com/libp2p/go-libp2p)
