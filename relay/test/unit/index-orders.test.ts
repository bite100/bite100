/**
 * 第 59 轮块 4：POST /orders 入口限流接线（src/index.ts）。
 * 限流在 JSON 解析与任何 D1 访问之前：第 1..N 个请求先撞到的是
 * 后续校验（此处用坏 JSON → 400 证明请求穿过了限流层），第 N+1 个
 * 直接 429。DB 用必抛错的替身——能走到 DB 的请求在本文件里不存在。
 */
import { describe, expect, it } from 'vitest'
import worker from '../../src/index'

const throwingDb = {
  prepare: () => {
    throw new Error('unit test must not reach D1 on this path')
  },
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} }

async function postOrders(ip: string): Promise<Response> {
  return worker.fetch(
    new Request('http://relay.test/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip },
      body: 'this is not json',
    }),
    { DB: throwingDb, ORDER_POST_RATE_LIMIT_PER_MIN: '3' } as never,
    ctx as never,
  )
}

describe('POST /orders 入口限流接线', () => {
  it('同 IP 第 4 个请求 → 429（前 3 个穿过限流层、死在 JSON 校验 400）', async () => {
    const ip = '203.0.113.10'
    for (let i = 0; i < 3; i++) {
      const res = await postOrders(ip)
      expect(res.status).toBe(400)
      expect(await res.text()).toContain('invalid json')
    }
    const fourth = await postOrders(ip)
    expect(fourth.status).toBe(429)
    expect(await fourth.text()).toContain('rate limited')
  })

  it('不同 IP 互不牵连', async () => {
    const res = await postOrders('203.0.113.11')
    expect(res.status).toBe(400)
  })
})
