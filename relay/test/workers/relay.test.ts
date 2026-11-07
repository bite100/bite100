import { SELF, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { BUILTIN_CHAINS } from '../../src/config'
import { buildSignedOrder, orderDigest } from '../../src/orders'
import { makeSignedOrder, TEST_ADDRESS } from '../helpers'

const BASE = 'http://relay.test'

async function postOrder(body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function getJson(path: string): Promise<{ status: number; data: never }> {
  const res = await SELF.fetch(`${BASE}${path}`)
  return { status: res.status, data: (await res.json()) as never }
}

describe('POST /orders 入库验签', () => {
  it('合法签名订单入库 200，返回 digest 与重建值一致', async () => {
    const body = await makeSignedOrder({})
    const res = await postOrder(body)
    expect(res.status).toBe(200)
    const data = (await res.json()) as { ok: boolean; orderId: string; digest: string }
    const expected = orderDigest(
      BUILTIN_CHAINS[11155111],
      buildSignedOrder(BUILTIN_CHAINS[11155111], body)!,
    )
    expect(data).toEqual({ ok: true, orderId: body.orderId, digest: expected })
  })

  it('重复投递去重：第二次返回 duplicate:true，库里只有一行', async () => {
    const body = await makeSignedOrder({})
    const first = await postOrder(body)
    expect(first.status).toBe(200)
    const second = await postOrder(body)
    expect(second.status).toBe(200)
    const data = (await second.json()) as { duplicate?: boolean }
    expect(data.duplicate).toBe(true)
    const { results } = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM orders WHERE order_id = ?',
    )
      .bind(body.orderId)
      .all<{ n: number }>()
    expect(results[0].n).toBe(1)
  })

  it('签名被篡改（换签名者）返回 401', async () => {
    const body = await makeSignedOrder({})
    const other = await makeSignedOrder({ orderId: body.orderId, nonce: 7 })
    const res = await postOrder({ ...body, signature: other.signature })
    expect(res.status).toBe(401)
  })

  it('已过期订单返回 400 order expired', async () => {
    const now = Math.floor(Date.now() / 1000)
    const body = await makeSignedOrder({ createdAt: now - 90000, expiresAt: now - 60 })
    const res = await postOrder(body)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('order expired')
  })

  it('未登记交易对 / 不支持的链 返回 400', async () => {
    const body = await makeSignedOrder({})
    expect((await postOrder({ ...body, pair: 'FOO/BAR' })).status).toBe(400)
    expect((await postOrder({ ...body, chainId: 999999 })).status).toBe(400)
  })

  it('Base Sepolia 订单按 Base 域验签入库', async () => {
    const body = await makeSignedOrder({ chainId: 84532 })
    const res = await postOrder(body)
    expect(res.status).toBe(200)
    const { data } = await getJson(`/orders?chain=84532&pair=BTC/USDT`)
    expect((data as unknown[]).length).toBeGreaterThanOrEqual(1)
  })

  it('Nostr 镜像不可达时入库照常成功（best-effort 不阻塞）', async () => {
    const body = await makeSignedOrder({})
    const res = await postOrder(body)
    expect(res.status).toBe(200)
    const row = await env.DB.prepare('SELECT nostr_event_id FROM orders WHERE order_id = ?')
      .bind(body.orderId)
      .first<{ nostr_event_id: string | null }>()
    // 测试环境 NOSTR_RELAYS 指向 127.0.0.1:9（不可达）：event id 应为空
    expect(row?.nostr_event_id ?? null).toBeNull()
  })
})

describe('GET /orders 查询', () => {
  it('按 pair / userAddress / chain 过滤；形状对齐节点 storage.Order', async () => {
    const a = await makeSignedOrder({ pair: 'ETH/USDT', side: 'sell' })
    const b = await makeSignedOrder({ pair: 'BTC/USDT' })
    await postOrder(a)
    await postOrder(b)

    const byPair = await getJson('/orders?pair=ETH/USDT')
    const pairRows = byPair.data as { orderId: string }[]
    expect(pairRows.map((r) => r.orderId)).toContain(a.orderId)
    expect(pairRows.map((r) => r.orderId)).not.toContain(b.orderId)

    const byUser = await getJson(`/orders?userAddress=${TEST_ADDRESS}`)
    const userRows = byUser.data as Record<string, unknown>[]
    expect(userRows.length).toBeGreaterThanOrEqual(2)
    const row = userRows.find((r) => r.orderId === a.orderId)!
    // 节点 storage.Order 的字段名逐项对齐
    for (const f of [
      'orderId',
      'trader',
      'pair',
      'side',
      'price',
      'amount',
      'filled',
      'status',
      'nonce',
      'createdAt',
      'expiresAt',
      'signature',
    ]) {
      expect(row).toHaveProperty(f)
    }
    expect(row.trader).toBe(TEST_ADDRESS.toLowerCase())

    const byChain = await getJson('/orders?chain=84532&pair=ETH/USDT')
    expect((byChain.data as unknown[]).map((r) => (r as { orderId: string }).orderId)).not.toContain(a.orderId)
  })

  it('过期订单不返回（直接插一行过期数据模拟存量）', async () => {
    const now = Math.floor(Date.now() / 1000)
    await env.DB.prepare(
      `INSERT INTO orders (digest, chain_id, order_id, user_address, pair, side, price, amount,
         amount_out, token_in, token_out, filled, status, nonce, created_at, expires_at,
         signature, raw_json, received_at)
       VALUES (?, 11155111, 'expired-row', ?, 'BTC/USDT', 'buy', '1', '1', '0', ?, ?, '0', 'open',
         0, ?, ?, '0x00', '{}', ?)`,
    )
      .bind(
        '0x' + 'ef'.repeat(32),
        TEST_ADDRESS.toLowerCase(),
        BUILTIN_CHAINS[11155111].tokens.BTC,
        BUILTIN_CHAINS[11155111].tokens.USDT,
        now - 100000,
        now - 10,
        now,
      )
      .run()
    const { data } = await getJson('/orders?pair=BTC/USDT&limit=200')
    expect((data as { orderId: string }[]).map((r) => r.orderId)).not.toContain('expired-row')
  })
})

describe('GET /orderbook 聚合', () => {
  it('买卖分开、价格-时间排序，形状为 {pair, bids, asks}', async () => {
    const buyLow = await makeSignedOrder({ side: 'buy', price: '50000000000000000000000', createdAt: 1700000100, expiresAt: 1999999999 })
    const buyHigh = await makeSignedOrder({ side: 'buy', price: '51000000000000000000000', createdAt: 1700000200, expiresAt: 1999999999 })
    const sell = await makeSignedOrder({ side: 'sell', price: '52000000000000000000000', createdAt: 1700000300, expiresAt: 1999999999 })
    await postOrder(buyLow)
    await postOrder(buyHigh)
    await postOrder(sell)

    const { status, data } = await getJson('/orderbook?pair=BTC/USDT')
    expect(status).toBe(200)
    const book = data as { pair: string; bids: { orderId: string }[]; asks: { orderId: string }[] }
    expect(book.pair).toBe('BTC/USDT')
    const bidIds = book.bids.map((r) => r.orderId)
    // 高价买单排在低价前
    expect(bidIds.indexOf(buyHigh.orderId)).toBeLessThan(bidIds.indexOf(buyLow.orderId))
    expect(book.asks.map((r) => r.orderId)).toContain(sell.orderId)
  })

  it('缺 pair 返回 400（与节点同口径）', async () => {
    const res = await SELF.fetch(`${BASE}/orderbook`)
    expect(res.status).toBe(400)
  })
})

describe('GET /health', () => {
  it('存活且 D1 连通', async () => {
    const { status, data } = await getJson('/health')
    expect(status).toBe(200)
    expect((data as { ok: boolean; db: string }).ok).toBe(true)
    expect((data as { ok: boolean; db: string }).db).toBe('ok')
  })
})
