# 中继节点部署（电脑端可用 + 自动更新）

中继节点只转发 P2P 订单/成交消息，不落库、不撮合，适合个人电脑或 VPS 长期挂机，并为前端提供 API（`http://本机:8080`）供连接下单。

---

## 一、Docker 部署（推荐）

### 1. 前置

- 安装 [Docker Desktop](https://www.docker.com/products/docker-desktop/)（Windows/Mac）
- 在仓库根目录打开终端

### 2. 启动中继

```bash
# 前台运行（看日志）
docker compose -f scripts/relay/docker-compose.relay.yml up --build

# 后台运行
docker compose -f scripts/relay/docker-compose.relay.yml up -d --build
```

- **P2P 端口**: 4001  
- **API/WebSocket**: http://localhost:8080  
- 前端配置: `VITE_NODE_API_URL=http://本机IP:8080`（手机/其他电脑访问时改为实际 IP）

**领奖地址（必填）**：在项目根目录建 `.env`，写入 `REWARD_WALLET=0x你的领奖地址`；节点会读取该环境变量，未设置则拒绝启动。若需自动提交证明领奖，再配置 `REWARD_ETH_PRIVATE_KEY` 并用定时任务跑 submitproof。

### 3. 自动更新

**方式 A：脚本定时更新（不依赖镜像仓库）**

Windows PowerShell（可加入计划任务，每日/每周执行）:

```powershell
cd D:\P2P   # 改为你的仓库路径
.\scripts\relay\run-relay.ps1 -AutoUpdate
```

或手动执行一次：

```powershell
.\scripts\relay\run-relay.ps1 -Detach    # 先启动
# 以后更新时
.\scripts\relay\run-relay.ps1 -AutoUpdate
```

**方式 B：Watchtower（需镜像从 registry 拉取时使用）**

若镜像推送到 Docker Hub 等，可启用 Watchtower 定时拉新镜像并重启：

```bash
docker compose -f scripts/relay/docker-compose.relay.yml --profile watchtower up -d
```

默认每小时检查一次；仅当镜像来自 registry 时有效。

---

## 二、本机直接运行（不装 Docker）

需安装 [Go 1.21+](https://go.dev/dl/)。

```powershell
cd node
copy config.relay-server.yaml config.yaml   # 首次
go run ./cmd/node -config config.relay-server.yaml
```

或编译后运行：

```powershell
cd node
go build -o p2p-relay.exe ./cmd/node
.\p2p-relay.exe -config config.relay-server.yaml
```

自动更新：定时 `git pull` 后重新 `go build` 并重启进程（可用计划任务或 NSSM 等做成服务）。

---

## 三、配置说明

- 配置文件: `node/config.relay-server.yaml`（Docker 中已挂载为容器内 `config.yaml`）
- **P2P 无中心**：无需“链接”到中心。不配 `bootstrap` 也能直接运行，本节点会监听 4001，等其它节点连你或你连别人；若你已知一些节点地址，可在 `network.bootstrap` 里填其 multiaddr，启动时会**自动连接**它们，连上后即参与 Gossip 互通订单/成交。
- **API**：`api.listen: ":8080"` 已开，前端连此地址即可下单；中继无本地订单簿，订单通过 Gossip 转发

---

## 四、验证

- 健康检查: 浏览器打开 `http://localhost:8080/api/health` 应返回 OK
- 前端: 在 `.env` 或构建环境里设置 `VITE_NODE_API_URL=http://本机IP:8080`，重新打包/启动前端后即可连到此中继

---

## 五、中继与撮合/存储的关系

中继节点**也可以交易**，只是功能更多（中继 + 存储 + 可选撮合）：

| 类型    | 中继转发 | 订单簿/存储 | 撮合 | 说明 |
|---------|----------|-------------|------|------|
| relay   | 是       | 是          | 可选 | 配置 `match.pairs` 后即参与撮合，与 match 一致 |
| storage | 否       | 是          | 否   | 仅持久化 |
| match   | 否       | 可选        | 是   | 仅撮合 |

当前 **config.relay-server.yaml** 已为 relay 开启存储（订单/成交落库）并预留 `match.pairs`；填好 `token0`/`token1` 后中继节点即同时做转发与撮合，前端连上即可交易。
