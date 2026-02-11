#!/bin/sh
# VPS 一键安装：Docker + Docker Compose + systemd 自启
# 用法：在仓库根目录执行 sudo ./scripts/vps/install-vps.sh
# 需 root 权限（写入 /etc/systemd/system/）
set -e

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 root 执行: sudo ./scripts/vps/install-vps.sh"
  exit 1
fi

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$REPO_ROOT"

echo "=== P2P 节点 VPS 一键安装 ==="
echo "仓库路径: $REPO_ROOT"

# 1. 安装 Docker（若未安装）
if ! command -v docker >/dev/null 2>&1; then
  echo "正在安装 Docker（使用官方便捷脚本）..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker || true
else
  echo "Docker 已安装: $(docker --version)"
fi

# 2. 确保 Docker Compose 可用（插件或独立命令）
if ! docker compose version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then
    echo "使用 docker-compose（独立命令）"
  else
    echo "请安装 Docker Compose 插件: apt install docker-compose-plugin"
    exit 1
  fi
else
  echo "Docker Compose 已就绪"
fi

# 3. 配置 .env
if [ ! -f "$REPO_ROOT/.env" ]; then
  if [ -f "$REPO_ROOT/.env.example" ]; then
    cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
  else
    echo "REWARD_WALLET=" > "$REPO_ROOT/.env"
  fi
fi
# 3b. 绑定领奖地址：环境变量 REWARD_WALLET 或交互式输入（用户友好的 CLI 绑定）
reward_addr=""
if [ -n "${REWARD_WALLET:-}" ]; then
  reward_addr=$(echo "$REWARD_WALLET" | tr -d '[:space:]')
elif [ -t 0 ] && [ -f "$REPO_ROOT/.env" ]; then
  current=$(grep -E "^REWARD_WALLET=" "$REPO_ROOT/.env" 2>/dev/null | cut -d= -f2-)
  if [ -z "$current" ] || [ "$current" = "0xYourRewardAddressHere" ] || [ "$current" = "0x你的领奖地址" ]; then
    printf "请输入领奖地址 (0x 开头 42 字符，留空跳过): "
    read -r reward_addr
    reward_addr=$(echo "$reward_addr" | tr -d '[:space:]')
  fi
fi
if [ -n "$reward_addr" ] && [ "${#reward_addr}" -eq 42 ] && [ "${reward_addr#0x}" != "$reward_addr" ]; then
  if grep -q "^REWARD_WALLET=" "$REPO_ROOT/.env" 2>/dev/null; then
    sed -i "s|^REWARD_WALLET=.*|REWARD_WALLET=$reward_addr|" "$REPO_ROOT/.env"
  else
    echo "REWARD_WALLET=$reward_addr" >> "$REPO_ROOT/.env"
  fi
  echo "已写入 REWARD_WALLET=$reward_addr"
elif [ -n "$reward_addr" ]; then
  echo "领奖地址格式有误，请稍后编辑 .env 填写 REWARD_WALLET"
fi

# 4. 创建 systemd 单元
SERVICE_NAME="p2p-node"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
cat > "$UNIT_FILE" << EOF
[Unit]
Description=P2P DEX Node (Docker Compose)
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$REPO_ROOT
ExecStart=/usr/bin/docker compose -f docker-compose.prod.yml --env-file .env up -d
ExecStop=/usr/bin/docker compose -f docker-compose.prod.yml down
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
EOF

# 兼容 docker-compose 独立命令
if ! docker compose version >/dev/null 2>&1 && command -v docker-compose >/dev/null 2>&1; then
  sed -i 's/docker compose/docker-compose/g' "$UNIT_FILE"
fi

systemctl daemon-reload
echo "已创建 systemd 单元: $UNIT_FILE"

# 5. 可选：配置 cron 自动更新（每日 3 点）
AUTO_UPDATE_SCRIPT="$REPO_ROOT/scripts/docker/auto-update-and-restart.sh"
chmod +x "$AUTO_UPDATE_SCRIPT" 2>/dev/null || true
CRON_LINE="0 3 * * * $AUTO_UPDATE_SCRIPT >> /var/log/p2p-docker-update.log 2>&1"
if [ -n "${CRON_AUTO_UPDATE:-}" ] && [ "$CRON_AUTO_UPDATE" = "1" ]; then
  ADD_CRON=1
elif [ -t 0 ]; then
  printf "是否配置每日 3 点自动更新并重启？[y/N] "
  read -r ans
  case "${ans:-n}" in [yY]|[yY][eE][sS]) ADD_CRON=1 ;; *) ADD_CRON=0 ;; esac
else
  ADD_CRON=0
  echo "非交互模式，跳过 cron 配置（可设置 CRON_AUTO_UPDATE=1 自动启用）"
fi
if [ "$ADD_CRON" = "1" ]; then
  (crontab -l 2>/dev/null | grep -v "auto-update-and-restart.sh" | grep -v "^$"; echo "$CRON_LINE") | crontab -
  touch /var/log/p2p-docker-update.log 2>/dev/null || true
  echo "已添加 cron 任务: 每日 3:00 执行 $AUTO_UPDATE_SCRIPT"
else
  echo "未配置 cron，可稍后参考 scripts/docker/README.md 手动添加"
fi

echo ""
echo "=== 安装完成 ==="
echo "1. 编辑 .env 填写 REWARD_WALLET: vi $REPO_ROOT/.env"
echo "2. 启动节点: systemctl start $SERVICE_NAME"
echo "3. 开机自启: systemctl enable $SERVICE_NAME"
echo "4. 查看状态: systemctl status $SERVICE_NAME"
echo "5. 查看日志: docker compose -f $REPO_ROOT/docker-compose.prod.yml logs -f"
echo ""
if [ "$ADD_CRON" = "1" ]; then
  echo "自动更新: 已配置 cron，日志 /var/log/p2p-docker-update.log"
else
  echo "自动更新: 参考 scripts/docker/README.md 配置 cron"
fi
