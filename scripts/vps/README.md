# VPS 一键部署

在 VPS（Linux）上一键安装 Docker、配置 systemd 自启，实现 P2P 节点开机自动运行。

## 用法

```bash
# 1. 克隆仓库后进入根目录
cd /path/to/P2P

# 2. 执行安装脚本（需 root）
sudo ./scripts/vps/install-vps.sh

# 3. 编辑 .env 填写领奖地址（安装时可交互输入，或执行时设置 REWARD_WALLET=0x...）
vi .env   # 若未在安装时输入，在此设置 REWARD_WALLET=0x你的地址

# 4. 启动并设置开机自启
sudo systemctl start p2p-node
sudo systemctl enable p2p-node
```

## 脚本功能

- 安装 Docker（若未安装，使用 get.docker.com）
- 创建 .env（若不存在）
- 创建 systemd 单元 `p2p-node.service`，开机自动 `docker compose up -d`

## 自动更新

安装时脚本会询问「是否配置每日 3 点自动更新」，选 `y` 即写入 root 的 crontab。非交互模式可设置 `CRON_AUTO_UPDATE=1` 自动启用。手动配置详见 [scripts/docker/README.md](../docker/README.md)。
