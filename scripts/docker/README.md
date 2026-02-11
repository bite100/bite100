# Docker 无人值守自动更新与运行

在 Docker 中运行 P2P 节点，并通过定时任务实现**无人值守自动更新并重启**。

---

## 一、首次部署（一次性）

1. **克隆仓库并进入根目录**
   ```bash
   cd /path/to/P2P   # 或 Windows: D:\P2P
   ```

2. **配置环境变量**
   ```bash
   cp .env.example .env
   # 编辑 .env，至少填写：
   # REWARD_WALLET=0x你的领奖地址
   # 可选: NETWORK, BOOTSTRAP_NODES, LOG_LEVEL 等
   ```

3. **启动节点**
   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env up -d --build
   ```
   - P2P 端口 4001，API/WebSocket 8080
   - 容器重启策略：`restart: unless-stopped`，宿主机重启后会自动拉起

---

## 二、无人值守自动更新

更新流程：**拉取最新代码 → 重新构建镜像 → 强制重建并启动容器**。无需人工干预。

### Linux（cron）

1. **赋予执行权限**
   ```bash
   chmod +x /path/to/P2P/scripts/docker/auto-update-and-restart.sh
   ```

2. **添加定时任务**
   ```bash
   crontab -e
   ```
   添加一行（示例：每天 3 点执行）：
   ```text
   0 3 * * * /path/to/P2P/scripts/docker/auto-update-and-restart.sh >> /var/log/p2p-docker-update.log 2>&1
   ```
   或每周一次（周日 3 点）：
   ```text
   0 3 * * 0 /path/to/P2P/scripts/docker/auto-update-and-restart.sh >> /var/log/p2p-docker-update.log 2>&1
   ```

### Windows（计划任务）

1. **打开「任务计划程序」**，创建基本任务。
2. **触发器**：按需选择（每日/每周，建议凌晨）。
3. **操作**：启动程序
   - 程序：`powershell.exe`
   - 参数：`-NoProfile -ExecutionPolicy Bypass -File "D:\P2P\scripts\docker\auto-update-and-restart.ps1"`
   - 起始于：`D:\P2P`（改为你的仓库根目录）
4. **完成**：保存后到点会自动执行脚本，拉代码、构建、重启容器。

### 手动执行一次

- **Linux**
  ```bash
  cd /path/to/P2P
  ./scripts/docker/auto-update-and-restart.sh
  ```
- **Windows PowerShell**
  ```powershell
  cd D:\P2P
  .\scripts\docker\auto-update-and-restart.ps1
  ```

---

## 三、监控（Prometheus + Grafana）

启用监控时使用 `--profile monitoring`：

```bash
docker compose -f docker-compose.prod.yml --env-file .env --profile monitoring up -d
```

会启动 Prometheus（9090）和 Grafana（3000）。访问 http://localhost:3000 登录 Grafana（默认 admin/admin），预置的「P2P 节点监控」仪表板可查看撮合 TPS、延迟等指标。

---

## 四、说明

- **领奖地址**：必须在 `.env` 中设置 `REWARD_WALLET`，否则节点会拒绝启动。
- **数据持久化**：节点数据在 volume `node-data`，更新与重启不会丢失。
- **Grafana 密码**：可通过 `.env` 设置 `GRAFANA_ADMIN_PASSWORD` 修改默认 admin 密码。
- **日志**：`docker compose -f docker-compose.prod.yml logs -f p2p-node` 查看节点日志。
- **仅更新不重启**：若只想拉代码并重建镜像、不立刻重启，可自行去掉脚本中的 `up -d --force-recreate`，仅保留 `build`。
