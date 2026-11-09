/**
 * DexScreener 参考价客户端单元测试（第六十轮）：
 * - 池子挑选：代币作 baseToken 命中、取流动性最大池的 priceUsd；
 * - 只作 quoteToken 出现时不冒充（返回 null）；无池/非法价 → null；
 * - 测试网链无 slug → 直接 null 不发请求；主网链带缓存。
 */
import { describe, it, expect, vi } from 'vitest'
import { fetchDexTokenUsdPrice, pickDexUsdPrice } from './dexReferencePrice'

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27ead9083C756Cc2'

describe('pickDexUsdPrice', () => {
  it('多个池取流动性最大者的价', () => {
    const pools = [
      { priceUsd: '2100.5', liquidity: { usd: 1000 }, baseToken: { address: WETH } },
      { priceUsd: '2132.08', liquidity: { usd: 500000 }, baseToken: { address: WETH } },
      { priceUsd: '1999', liquidity: { usd: 10 }, baseToken: { address: WETH } },
    ]
    expect(pickDexUsdPrice(pools, WETH)).toBe(2132.08)
  })

  it('代币只作 quoteToken 出现 → null（不反推冒充）', () => {
    const pools = [
      { priceUsd: '0.5', liquidity: { usd: 100 }, baseToken: { address: '0xabc' }, quoteToken: { address: WETH } },
    ]
    expect(pickDexUsdPrice(pools, WETH)).toBeNull()
  })

  it('空数组/非数组/非法价 → null', () => {
    expect(pickDexUsdPrice([], WETH)).toBeNull()
    expect(pickDexUsdPrice(null, WETH)).toBeNull()
    expect(pickDexUsdPrice([{ priceUsd: 'abc', baseToken: { address: WETH } }], WETH)).toBeNull()
    expect(pickDexUsdPrice([{ priceUsd: '0', baseToken: { address: WETH } }], WETH)).toBeNull()
  })
})

describe('fetchDexTokenUsdPrice', () => {
  it('测试网链（Sepolia）不索引 → null 且不发请求', async () => {
    const fetchFn = vi.fn()
    await expect(fetchDexTokenUsdPrice(11155111, WETH, { fetchFn: fetchFn as never })).resolves.toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('主网链：解析响应并缓存（第二次不发请求）', async () => {
    const token = '0x00000000000000000000000000000000000000aa'
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => [
        { priceUsd: '3.25', liquidity: { usd: 777 }, baseToken: { address: token } },
      ],
    }))
    await expect(fetchDexTokenUsdPrice(1, token, { fetchFn: fetchFn as never, nowMs: 1000 })).resolves.toBe(3.25)
    await expect(fetchDexTokenUsdPrice(1, token, { fetchFn: fetchFn as never, nowMs: 2000 })).resolves.toBe(3.25)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('HTTP 失败/抛错 → null（降级，不抛）', async () => {
    const token = '0x00000000000000000000000000000000000000bb'
    const fetchFn = vi.fn(async () => ({ ok: false, json: async () => [] }))
    await expect(fetchDexTokenUsdPrice(8453, token, { fetchFn: fetchFn as never })).resolves.toBeNull()
    const throwFn = vi.fn(async () => {
      throw new Error('boom')
    })
    await expect(fetchDexTokenUsdPrice(8453, token, { fetchFn: throwFn as never })).resolves.toBeNull()
  })
})
