/**
 * 本地全链路演示客户端：用测试钱包（maker.env）的真实私钥签一张真订单，
 * 打本地 wrangler dev 起的中继，走完 投递→入库→查回→orderbook→过期拒→
 * 坏签名拒→重复去重→Nostr 镜像 event id 记录 全流程。
 *
 * 安全：脚本自己读 MAKER_ENV 文件里的 PRIVATE_KEY，全程不打印、不落盘、
 * 不写进任何日志。用法（一般经 scripts/run-demo.sh 编排）：
 *   RELAY_URL=http://127.0.0.1:8787 node scripts/demo.mjs
 * 环境变量：RELAY_URL（默认 http://127.0.0.1:8787）、
 *           MAKER_ENV（默认 ~/workspace/bite100-deployer/maker.env）
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'

const RELAY_URL = (process.env.RELAY_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const MAKER_ENV =
  process.env.MAKER_ENV ?? join(homedir(), 'workspace/bite100-deployer/maker.env')

// Sepolia 配置（与 relay/src/config.ts 及前端 chains.ts 一致）
// 签名域的 verifyingContract：必须与 src/config.ts 的 Sepolia settlement 一致
// （第 34 轮按第 33 轮部署栈更新；改其一必须同步改另一处，演示验签会当场报错）
const SETTLEMENT = '0xa3F8cBCDc1533299D37836ea80d5004FF59f9094'
const BTC = '0x8EDa0025C245B10eA1E10c257674B794C85350f3'
const USDT = '0x6Ca8cb68Ee5BB15474f1cfFE07B895C974Ab9c6e'
const CHAIN_ID = 11155111

const ORDER_TYPES = {
  Order: [
    { name: 'orderId', type: 'string' },
    { name: 'userAddress', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'amountOut', type: 'uint256' },
    { name: 'price', type: 'uint256' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'side', type: 'uint8' },
  ],
}

function loadAccount() {
  const text = readFileSync(MAKER_ENV, 'utf8')
  const m = text.match(/^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m)
  if (!m) throw new Error(`PRIVATE_KEY not found in maker env file`)
  return privateKeyToAccount(m[1]) // 私钥只进内存，不打印
}

const results = []
function step(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`[demo] ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function signOrder(account, { orderId, createdAt, expiresAt, side }) {
  const amount = '1000000000000000000'
  const price = '60000000000000000000000'
  const message = {
    orderId,
    userAddress: account.address,
    tokenIn: BTC,
    tokenOut: USDT,
    amountIn: BigInt(amount),
    amountOut: (BigInt(amount) * BigInt(price)) / 10n ** 18n,
    price: BigInt(price),
    timestamp: BigInt(createdAt),
    expiresAt: BigInt(expiresAt),
    nonce: 0n,
    // 签名字段 side（uint8，规范 §2）：buy ↔ 0、sell ↔ 1，与请求体 side 字符串对应
    side: side === 'buy' ? 0 : 1,
  }
  const signature = await account.signTypedData({
    domain: { name: '比特100', version: '1', chainId: CHAIN_ID, verifyingContract: SETTLEMENT },
    types: ORDER_TYPES,
    primaryType: 'Order',
    message,
  })
  return {
    orderId,
    trader: account.address,
    pair: 'BTC/USDT',
    side,
    price,
    amount,
    filled: '0',
    status: 'open',
    nonce: 0,
    createdAt,
    expiresAt,
    signature,
    chainId: CHAIN_ID,
  }
}

async function main() {
  const account = loadAccount()
  console.log(`[demo] maker address: ${account.address}`)
  console.log(`[demo] relay: ${RELAY_URL}`)
  const now = Math.floor(Date.now() / 1000)

  // 1) health
  const health = await fetch(`${RELAY_URL}/health`).then((r) => r.json())
  step('GET /health', health.ok === true && health.db === 'ok', JSON.stringify(health))

  // 2) 投递真实签名订单
  const orderId = `demo-${now}`
  const order = await signOrder(account, {
    orderId,
    createdAt: now,
    expiresAt: now + 86400,
    side: 'buy',
  })
  const post1 = await fetch(`${RELAY_URL}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(order),
  })
  const post1Data = await post1.json()
  step(
    'POST /orders 真实签名订单入库',
    post1.status === 200 && post1Data.ok === true && /^0x[0-9a-f]{64}$/.test(post1Data.digest ?? ''),
    `digest=${post1Data.digest}`,
  )

  // 3) 重复投递去重
  const post2 = await fetch(`${RELAY_URL}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(order),
  })
  const post2Data = await post2.json()
  step('POST /orders 重复投递去重', post2.status === 200 && post2Data.duplicate === true)

  // 4) 按交易对查回
  const byPair = await fetch(`${RELAY_URL}/orders?chain=${CHAIN_ID}&pair=BTC/USDT`).then((r) =>
    r.json(),
  )
  step(
    'GET /orders?pair= 查回',
    Array.isArray(byPair) && byPair.some((o) => o.orderId === orderId),
    `pair rows=${Array.isArray(byPair) ? byPair.length : 'n/a'}`,
  )

  // 5) 按地址查回
  const byUser = await fetch(`${RELAY_URL}/orders?userAddress=${account.address}`).then((r) =>
    r.json(),
  )
  step(
    'GET /orders?userAddress= 查回',
    Array.isArray(byUser) && byUser.some((o) => o.orderId === orderId),
  )

  // 6) orderbook 查回
  const book = await fetch(`${RELAY_URL}/orderbook?chain=${CHAIN_ID}&pair=BTC/USDT`).then((r) =>
    r.json(),
  )
  step(
    'GET /orderbook 查回（在 bids 中）',
    Array.isArray(book.bids) && book.bids.some((o) => o.orderId === orderId),
    `bids=${book.bids?.length} asks=${book.asks?.length}`,
  )

  // 7) 过期单被拒（签名本身合法、仅已过期）
  const expired = await signOrder(account, {
    orderId: `demo-expired-${now}`,
    createdAt: now - 90000,
    expiresAt: now - 60,
    side: 'sell',
  })
  const postExpired = await fetch(`${RELAY_URL}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(expired),
  })
  step('过期订单被拒', postExpired.status === 400, `HTTP ${postExpired.status}`)

  // 8) 坏签名被拒（换一张单的签名）
  const other = await signOrder(account, {
    orderId: `demo-other-${now}`,
    createdAt: now,
    expiresAt: now + 3600,
    side: 'buy',
  })
  const postBad = await fetch(`${RELAY_URL}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...order, orderId: `demo-bad-${now}`, signature: other.signature }),
  })
  step('坏签名被拒', postBad.status === 401, `HTTP ${postBad.status}`)

  // 9) Nostr 镜像 event id 记录（异步 waitUntil，轮询等待回填）
  let eventId = null
  for (let i = 0; i < 10 && !eventId; i++) {
    const rows = await fetch(`${RELAY_URL}/orders?userAddress=${account.address}`).then((r) =>
      r.json(),
    )
    const row = Array.isArray(rows) ? rows.find((o) => o.orderId === orderId) : null
    eventId = row?.nostrEventId ?? null
    if (!eventId) await new Promise((r) => setTimeout(r, 1000))
  }
  step(
    'Nostr 镜像 event id 已记录',
    typeof eventId === 'string' && /^[0-9a-f]{64}$/.test(eventId),
    eventId ? `event_id=${eventId}` : '未记录（镜像未配置或中继不可达，见 README 实测记录）',
  )

  const failed = results.filter((r) => !r.ok)
  console.log(
    `[demo] done: ${results.length - failed.length}/${results.length} steps passed` +
      (failed.length ? `（失败：${failed.map((f) => f.name).join('；')}）` : ''),
  )
  // 第 9 步（镜像）为 best-effort 观察项，不计入退出码；其余步骤失败才算演示失败
  const hardFailed = results.slice(0, 8).filter((r) => !r.ok)
  process.exitCode = hardFailed.length ? 1 : 0
}

main().catch((e) => {
  console.error(`[demo] fatal: ${e.message}`)
  process.exitCode = 1
})
