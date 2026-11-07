#!/usr/bin/env bash
# 本地全链路演示编排：mock Nostr 中继 + wrangler dev（本地 D1）+ demo.mjs。
# 邮差密钥由 gen-postman.mjs 生成到 /tmp（仓库外），再注入 gitignore 的 .dev.vars；
# maker 私钥由 demo.mjs 自己读 maker.env，全程不打印。
# 用法：bash scripts/run-demo.sh
set -u
cd "$(dirname "$0")/.."

POSTMAN_FILE=/tmp/bit100-relay-postman.env
MOCK_LOG=/tmp/bit100-relay-mock.log
DEV_LOG=/tmp/bit100-relay-dev.log
PORT=8787

cleanup() {
  [ -n "${DEV_PID:-}" ] && kill "$DEV_PID" 2>/dev/null
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null
  rm -f .dev.vars
}
trap cleanup EXIT

echo "== 1. 生成一次性邮差密钥（仓库外） =="
node scripts/gen-postman.mjs "$POSTMAN_FILE"

echo "== 2. 写 .dev.vars（gitignore，不入库）：邮差密钥 + mock 中继地址 =="
SECRET_HEX=$(grep '^NOSTR_POSTMAN_SECRET_HEX=' "$POSTMAN_FILE" | cut -d= -f2)
printf 'NOSTR_POSTMAN_SECRET_HEX=%s\nNOSTR_RELAYS=ws://127.0.0.1:7777\n' "$SECRET_HEX" > .dev.vars

echo "== 3. 起 mock Nostr 中继（ws://127.0.0.1:7777） =="
node scripts/mock-relay.mjs 7777 >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!

echo "== 4. 应用 D1 migration（本地） =="
npx wrangler d1 migrations apply bit100-relay-orders --local 2>&1 | tail -3

echo "== 5. 起 wrangler dev（:${PORT}） =="
npx wrangler dev --port "$PORT" >"$DEV_LOG" 2>&1 &
DEV_PID=$!
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -s "http://127.0.0.1:${PORT}/health" || { echo "worker did not come up"; tail -20 "$DEV_LOG"; exit 1; }
echo

echo "== 6. 跑全链路 demo =="
RELAY_URL="http://127.0.0.1:${PORT}" node scripts/demo.mjs
DEMO_RC=$?

echo "== 7. mock 中继收到的事件 =="
cat "$MOCK_LOG"
exit "$DEMO_RC"
