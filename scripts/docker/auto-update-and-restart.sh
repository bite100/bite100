#!/bin/sh
# P2P 节点 - Docker 无人值守自动更新并重启
# 用法: 在仓库根目录执行 ./scripts/docker/auto-update-and-restart.sh
# 或由 cron 定时执行，例如每日 3 点: 0 3 * * * /path/to/P2P/scripts/docker/auto-update-and-restart.sh

set -e
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.prod.yml"
ENV_FILE="$REPO_ROOT/.env"

cd "$REPO_ROOT"

echo "拉取最新代码..."
git pull

echo "重新构建并启动节点容器..."
if [ -f "$ENV_FILE" ]; then
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build --no-cache
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --force-recreate
else
  echo "未找到 .env，使用默认环境变量。建议复制 .env.example 为 .env 并填写 REWARD_WALLET 等。"
  docker compose -f "$COMPOSE_FILE" build --no-cache
  docker compose -f "$COMPOSE_FILE" up -d --force-recreate
fi

echo "节点已更新并运行。"
docker compose -f "$COMPOSE_FILE" ps
