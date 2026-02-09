# P2P 节点

Phase 2 节点软件：libp2p 网络接入，支持存储节点、中继节点与撮合节点。

**重要**：**节点入网无任何条件**，无需白名单、无需质押、无需邀请，任何节点都可以自由加入网络。

**领奖地址必填**：可通过启动参数 `-reward-wallet`、环境变量 `REWARD_WALLET` 或配置文件 `node.reward_wallet` 设置，未设置则节点拒绝启动。

**Windows 图形界面**：可双击 `启动节点-GUI.bat` 或运行 `.\run-node-gui.ps1`，在弹出窗口中输入领奖钱包地址后点击「启动节点」即可运行（可选「记住地址」下次自动填充）。界面提供「检查更新」可拉取代码、重新构建并自动重启节点。

**自动更新并自动重启**：双击 `自动更新.bat` 或运行 `.\update-and-restart.ps1`，会执行 `git pull`、重新 `go build -o node.exe`、停止当前节点进程并在新窗口重新启动节点（领奖地址从「记住地址」或环境变量 `REWARD_WALLET` 读取）。可放入 Windows 计划任务定时执行。

## M1：两节点连通

### 运行方式（任选其一，无需额外安装）

**方式一：Docker（推荐，无需 Go）**

```bash
cd node
docker build -t p2p-node .
docker run -it --rm -p 4001:4001 p2p-node -reward-wallet 0x你的领奖地址
```

**方式二：一键脚本（自动选 Docker 或 Go）**

```powershell
# Windows（-rewardWallet 必填）
cd node
.\run.ps1 -rewardWallet 0x你的领奖地址
```

```bash
# Linux / macOS（-reward-wallet 必填）
cd node
chmod +x run.sh && ./run.sh -reward-wallet 0x你的领奖地址
```

**方式三：Go 源码**

```bash
cd node
go mod tidy   # 首次运行需拉取依赖
go run ./cmd/node -reward-wallet 0x你的领奖地址
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
.\run.ps1 -rewardWallet 0x你的领奖地址 -port 4002 -connect /ip4/127.0.0.1/tcp/4001/p2p/12D3KooWAbc123...
```

**注意**：`12D3KooWAbc123...` 要换成节点 A 实际打印的 PeerID，不要写成字面量 `<PeerID>`。

### 验收

- 节点 A 日志出现 `已连接对等节点: <PeerID>`
- 节点 B 日志出现 `已连接到远程节点，当前连接数: 1`
- 按 Ctrl+C 可正常退出

### 测试 GossipSub 消息

两节点连通后，可用 `-publishTopic` 和 `-publishMsg` 向 topic 发送消息，另一节点会打印收到的内容。

**终端 1（节点 A）**：`.\run.ps1 -rewardWallet 0x你的领奖地址`，记录输出的 PeerID 和地址。

**终端 2（节点 B）**：连接节点 A 并发送一条测试消息：

```powershell
.\run.ps1 -rewardWallet 0x你的领奖地址 -port 4002 -connect /ip4/127.0.0.1/tcp/4001/p2p/<节点A的PeerID> -publishTopic /p2p-exchange/sync/trades -publishMsg "hello from B"
```

预期：节点 A 打印 `[/p2p-exchange/sync/trades] 来自 <B的PeerID>: 13 bytes`。

### M2：存储节点与 SyncTrades（P2P 下载）

**P2P 下载模型**：有数据的节点作为热点，无数据的节点主动请求并下载，下载完成后作为热点打开，供其他节点拉取。

- **热点（有数据）**：存储节点或已完成下载的节点，注册 SyncTrades 协议，响应其他节点的拉取请求。
- **拉取方（无数据）**：使用 `-sync-from <PeerID>` 向热点请求并下载，数据写入本地（storage 节点写主 DB，relay 写 `data_dir_downloads/`）。
- **下载完成后**：拉取方自动注册 SyncTrades 并保持运行，作为热点供其他节点下载，形成 P2P 分发网。

**存储节点（初始热点）**：`config.yaml` 中 `node.type: storage`，会初始化本地 SQLite，并启动保留期定时清理。**默认两周**（`storage.retention_months` 为 0 时，>0 为月数）。

**SyncTrades 协议**：存储节点注册 `/p2p-exchange/sync/trades/1.0.0`，按 `since`/`until`/`limit` 返回本节点已保留范围内的数据（默认两周）。

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

- **中继节点**（`node.type: relay`）：订阅配置中的 topics，收到消息时统计转发字节数（**bytesRelayed**），并写入周期贡献证明。
- **中继指标**：收到每条 Gossip 消息累加字节数；证明内 `metrics.bytesRelayed` 为**本周期增量**（每周期证明写入后推进快照，下一周期为累计差），供链上 ContributorReward 提交及经济模型 15% 中继分配使用。
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
- **Phase 3.1**：Gossip 主题 `/p2p-exchange/order/new`、`/order/cancel`、`/trade/executed`、`/sync/orderbook`；存储节点订阅后持久化订单（orders 表）、成交（trades）、订单簿快照，并按保留期清理（默认两周）。
- **Phase 3.2**：撮合节点（`node.type: match`）订阅 order/new、order/cancel，维护内存订单簿，Price-Time 撮合，广播 /trade/executed；需在 `match.pairs` 中配置交易对与链上代币（token0/token1）以便成交含结算字段。链上结算需 Settlement owner 调用 `settleTrade`（可用 cast 或单独 settler）。
- **Phase 3.3**：中继节点限流与信誉（抗 Sybil 基础）。`relay.rate_limit_bytes_per_sec_per_peer` / `rate_limit_msgs_per_sec_per_peer` 非 0 时启用按 peer 限流，超限丢弃并记违规；所有中继节点记录每 peer 的转发量与违规次数（信誉），供后续降权或踢出。主题划分沿用 `network.topics`，可按需按 pair 拆子主题。
- 支持项：`node.type`（storage|relay|match）、`node.data_dir`、`node.listen`；`network.bootstrap`、`network.topics`；`relay.rate_limit_*`（Phase 3.3）；`storage.retention_months`；`match.pairs`；`metrics.proof_period_days`、`metrics.proof_output_dir`；`chain.*`（可选）。
- 启动时加 `-config <path>` 指定配置文件。
- **节点发现**：`network.bootstrap` 填写稳定节点的 multiaddr（如 `/ip4/公网IP/tcp/4001/p2p/<PeerID>`），启动时会连接并加入 DHT；无 Bootstrap 时也可用 `-connect <multiaddr>` 直连。多区域/多运营商连通性说明见 [节点发现与 Bootstrap](../docs/节点发现与Bootstrap.md)。

## 项目结构

```
node/
├── cmd/
│   ├── node/        # 节点入口
│   └── submitproof/ # 链上提交贡献证明（可选）
├── internal/
│   ├── config/      # 配置加载
│   ├── p2p/         # libp2p host, DHT, GossipSub
│   ├── storage/     # SQLite 成交表、订单表（Phase 3.1）、订单簿快照、保留期（默认两周）
│   ├── sync/        # SyncTrades 协议、Gossip 订单/成交解析与持久化（Phase 3.1）
│   ├── match/       # 撮合引擎（Phase 3.2）：订单簿、Price-Time 撮合
│   ├── settlement/  # 链上结算占位（Phase 3.2）：需 Settlement owner 调用 settleTrade
│   ├── relay/       # 中继限流与信誉（Phase 3.3）：按 peer 限流、违规记录
│   ├── metrics/     # uptime、storage、bytes relayed、贡献证明
│   ├── reward/      # 贡献证明链上提交（ECDSA 签名与 calldata）
│   └── chain/       # 可选：链上 Swap 事件拉取
├── config.example.yaml
├── go.mod
└── README.md
```

## 参考

- [Phase2 设计文档](../docs/Phase2-设计文档.md)
- [节点发现与 Bootstrap](../docs/节点发现与Bootstrap.md)：Bootstrap 配置、DHT、多区域连通性
- [go-libp2p](https://github.com/libp2p/go-libp2p)
