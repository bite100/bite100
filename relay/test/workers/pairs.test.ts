/**
 * 第六十轮：自助上架注册表的 Worker 集成测试（真实 fetch 入口 + 本地 D1）。
 * 注册端点的链上复读依赖 RPC（测试环境 RPC 指向不可达地址），故成功注册
 * 路径由 test/unit/pairs.test.ts 以注入替身覆盖；这里覆盖：端点形状、
 * 不依赖 RPC 的校验拒绝、直接落库注册行后的下单全路径（注册表解析 →
 * 验签 → 入库 → 订单簿可见）、错地址被拒。
 */
import { SELF, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { buildPairKey } from '../../src/pairs'
import { makeSignedOrder } from '../helpers'

const BASE = 'http://relay.test'
const TOKEN_A = '0x1111111111111111111111111111111111111111'
const TOKEN_B = '0x2222222222222222222222222222222222222222'
const PAIR_KEY = buildPairKey(11155111, TOKEN_A, TOKEN_B)

async function postJson(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 直接往注册表落一行（模拟一次已完成的注册，元数据视为链上复读结果） */
async function seedPairRow() {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO pairs
       (chain_id, pair_key, base_token, quote_token, base_symbol, quote_symbol,
        base_name, quote_name, base_decimals, quote_decimals, creator, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      11155111,
      PAIR_KEY,
      TOKEN_A,
      TOKEN_B,
      'TKX6',
      'TUSD',
      'Token X Six',
      'Test USD',
      6,
      18,
      null,
      Math.floor(Date.now() / 1000),
    )
    .run()
}

describe('GET /pairs', () => {
  it('分页：第 59 轮 X-Pairs-Total / X-Pairs-Truncated 头与 limit/offset 生效', async () => {
    await seedPairRow()
    const res = await SELF.fetch(`${BASE}/pairs?chain=11155111&limit=1`)
    expect(res.status).toBe(200)
    const rows = (await res.json()) as unknown[]
    expect(rows).toHaveLength(1)
    expect(res.headers.get('X-Pairs-Total')).toBe('1')
    expect(res.headers.get('X-Pairs-Truncated')).toBe('false')
    // offset 越过全部行：空数组但 total 仍报真实总数
    const res2 = await SELF.fetch(`${BASE}/pairs?chain=11155111&limit=1&offset=1`)
    const rows2 = (await res2.json()) as unknown[]
    expect(rows2).toHaveLength(0)
    expect(res2.headers.get('X-Pairs-Total')).toBe('1')
    expect(res2.headers.get('X-Pairs-Truncated')).toBe('false')
  })

  it('返回数组；落库后包含该对（字段齐全）', async () => {
    await seedPairRow()
    const res = await SELF.fetch(`${BASE}/pairs?chain=11155111`)
    expect(res.status).toBe(200)
    const rows = (await res.json()) as Array<Record<string, unknown>>
    const found = rows.find((r) => r.pairKey === PAIR_KEY)
    expect(found).toBeTruthy()
    expect(found).toMatchObject({
      chainId: 11155111,
      baseToken: TOKEN_A,
      quoteToken: TOKEN_B,
      baseSymbol: 'TKX6',
      quoteSymbol: 'TUSD',
      baseDecimals: 6,
      quoteDecimals: 18,
    })
  })

  it('非法 chain 参数返回 400', async () => {
    const res = await SELF.fetch(`${BASE}/pairs?chain=abc`)
    expect(res.status).toBe(400)
  })
})

describe('POST /pairs 校验（不依赖 RPC 的拒绝路径）', () => {
  it('坏地址 / 同币 / 不支持的链 → 400', async () => {
    expect(
      (await postJson('/pairs', { chainId: 11155111, baseToken: '0x123', quoteToken: TOKEN_B }))
        .status,
    ).toBe(400)
    expect(
      (await postJson('/pairs', { chainId: 11155111, baseToken: TOKEN_A, quoteToken: TOKEN_A }))
        .status,
    ).toBe(400)
    expect(
      (await postJson('/pairs', { chainId: 999999, baseToken: TOKEN_A, quoteToken: TOKEN_B }))
        .status,
    ).toBe(400)
  })
})

describe('注册表与下单全路径', () => {
  it('未注册的地址型对下单 → 400 unknown pair', async () => {
    const key = buildPairKey(11155111, TOKEN_B, TOKEN_A) // 反向对，未注册
    const body = await makeSignedOrder({
      pair: key,
      tokens: { tokenIn: TOKEN_B, tokenOut: TOKEN_A },
    })
    const res = await postJson('/orders', body)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('unknown pair')
  })

  it('已注册对：签名订单入库 200，订单簿可见', async () => {
    await seedPairRow()
    const body = await makeSignedOrder({
      pair: PAIR_KEY,
      tokens: { tokenIn: TOKEN_A, tokenOut: TOKEN_B },
      side: 'sell',
      amount: '100000000', // 100 TKX6（6 位小数）
      price: '2000000000000000000000000000000', // 人类价 2（价格缩放 18+18-6=30）
    })
    const res = await postJson('/orders', body)
    expect(res.status).toBe(200)
    const data = (await res.json()) as { ok: boolean; digest: string }
    expect(data.ok).toBe(true)

    const bookRes = await SELF.fetch(
      `${BASE}/orderbook?chain=11155111&pair=${encodeURIComponent(PAIR_KEY)}`,
    )
    expect(bookRes.status).toBe(200)
    const book = (await bookRes.json()) as { asks: Array<{ orderId: string }> }
    expect(book.asks.some((o) => o.orderId === body.orderId)).toBe(true)
  })

  it('键内地址与注册行不一致（冒用已注册 base 换 quote）→ 400', async () => {
    await seedPairRow()
    const forged = buildPairKey(11155111, TOKEN_A, '0x4444444444444444444444444444444444444444')
    const body = await makeSignedOrder({
      pair: forged,
      tokens: { tokenIn: TOKEN_A, tokenOut: '0x4444444444444444444444444444444444444444' },
    })
    const res = await postJson('/orders', body)
    expect(res.status).toBe(400)
  })

  it('种子符号对照旧可用（回归）', async () => {
    const body = await makeSignedOrder({ pair: 'ETH/USDT' })
    const res = await postJson('/orders', body)
    expect(res.status).toBe(200)
  })
})
