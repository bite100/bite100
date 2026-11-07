#!/usr/bin/env bash
# 本地 anvil 端到端验证（P0-3）：启动本地链 -> 构建合约 -> 运行 Go E2E 测试 -> 关闭本地链。
# 只连本地 127.0.0.1:8545，绝不访问外部网络。用法：bash scripts/anvil-e2e.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/workspace/tools/foundry:$HOME/workspace/tools/go/bin:$PATH"
PORT=8545
RPC="http://127.0.0.1:${PORT}"

cleanup() {
  if [[ -n "${ANVIL_PID:-}" ]]; then kill "$ANVIL_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

echo "[1/4] forge build"
(cd "$ROOT/contracts" && forge build --quiet)

echo "[2/4] start anvil on ${RPC}"
anvil --port "$PORT" --silent &
ANVIL_PID=$!
for i in $(seq 1 50); do
  if curl -s -o /dev/null -X POST -H 'content-type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC"; then
    break
  fi
  sleep 0.2
done

echo "[3/4] go test (anvil e2e)"
cd "$ROOT/node"
BIT100_ANVIL_RPC="$RPC" go test ./internal/settlement/ -run TestAnvilE2E -v -count=1

echo "[4/4] done"
