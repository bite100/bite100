#!/usr/bin/env bash
# 第 43 轮块 A：多腿双路对账一键复跑（结构与 D1 的 run.sh 同构）。
# 同一套场景在本地 anvil 上跑两遍：
#   1) 节点路径：Go 节点引擎撮合 + 节点 SubmitTrade/批量提交（逐腿提交）
#   2) 前端路径：全新 anvil 上用生产撮合模块（matchTaker/simulateAndPrune）
#      撮合 + settleTradesBatch 原子批量结算
# 然后 compare-multileg.mjs 逐项对账（腿序列/成交腿/陈旧腿/余量/累计量/
# 手续费分账/gas 份额恒等/净额分解/nonce 水位）。
# 两轮 anvil 同 gasprice（1 gwei）同链，保证两路部署地址一致、计量可比。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export PATH="$HOME/workspace/tools/foundry:$HOME/workspace/tools/go/bin:$PATH"
OUT_DIR="$(mktemp -d /tmp/bit100-multileg.XXXXXX)"
PORT=8549
RPC="http://127.0.0.1:${PORT}"
ANVIL_PID=""

cleanup() {
  if [ -n "$ANVIL_PID" ]; then kill "$ANVIL_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

start_anvil() {
  anvil --host 127.0.0.1 --port "$PORT" --gas-price 1000000000 --silent &
  ANVIL_PID=$!
  for _ in $(seq 1 50); do
    if curl -s -o /dev/null -X POST -H 'content-type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC"; then
      return 0
    fi
    sleep 0.2
  done
  echo "anvil 启动超时" >&2
  exit 1
}

echo "== forge build（合约）=="
(cd "$ROOT/contracts" && forge build --silent)

echo "== 打包前端路径驱动 =="
(cd "$ROOT/frontend" && node scripts/stage3-e2e/build.mjs)

echo "== 节点路径（Go 多腿 E2E）=="
start_anvil
(cd "$ROOT/node" && BIT100_ANVIL_RPC="$RPC" BIT100_MULTILEG_OUT="$OUT_DIR/node.json" \
  go test ./internal/settlement/ -run TestAnvilStage3MultiLegNodePath -count=1 -v)
kill "$ANVIL_PID" 2>/dev/null || true
ANVIL_PID=""
sleep 0.5

echo "== 前端路径（生产撮合 + 原子批量结算，全新 anvil）=="
start_anvil
(cd "$ROOT" && node frontend/scripts/stage3-e2e/dist/driver-multileg.mjs "$RPC" "$OUT_DIR/frontend.json")
kill "$ANVIL_PID" 2>/dev/null || true
ANVIL_PID=""

echo "== 对账 =="
node "$ROOT/frontend/scripts/stage3-e2e/compare-multileg.mjs" "$OUT_DIR/node.json" "$OUT_DIR/frontend.json"
echo "产物目录: $OUT_DIR"
