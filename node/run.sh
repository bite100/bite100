#!/bin/sh
# P2P 节点启动脚本 - 优先 Docker，否则 Go
# 领奖地址必填，否则节点拒绝启动。
# 用法: ./run.sh -reward-wallet 0x你的地址 [ -connect <addr> ] [ -port 4002 ]
cd "$(dirname "$0")"

if command -v docker >/dev/null 2>&1; then
  docker run -it --rm -p 4001:4001 -v "$(pwd):/app" -w /app golang:1.21-alpine \
    sh -c "go mod download && go run ./cmd/node $*"
  exit $?
fi

if command -v go >/dev/null 2>&1; then
  go run ./cmd/node "$@"
  exit $?
fi

echo "请安装 Docker 或 Go"
exit 1
