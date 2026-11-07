/**
 * useTokenPrice / usePairMarketPrice 单元测试（mock fetch）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useTokenPrice, usePairMarketPrice, PAIR_COINGECKO_IDS } from './useTokenPrice'

describe('PAIR_COINGECKO_IDS', () => {
  it('does not map TKA/TKB to any external asset (第二十三轮：测试代币无外部报价，禁止冒充)', () => {
    expect(PAIR_COINGECKO_IDS['TKA/TKB']).toBeUndefined()
    expect(PAIR_COINGECKO_IDS['TKB/TKA']).toBeUndefined()
  })
})

describe('useTokenPrice', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns loading then price when fetch succeeds', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          ethereum: { usd: 2000, usd_24h_change: 1.5 },
        }),
    })
    const { result } = renderHook(() => useTokenPrice('ethereum', 0))
    expect(result.current.loading).toBe(true)
    expect(result.current.price).toBeNull()

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.price).toEqual({ usd: 2000, usd_24h_change: 1.5 })
    expect(result.current.error).toBeNull()
  })

  it('sets error when token id not in response', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: () => Promise.resolve({}),
    })
    const { result } = renderHook(() => useTokenPrice('unknown-token', 0))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.price).toBeNull()
    expect(result.current.error?.message).toContain('unknown-token')
  })

  it('exposes refetch that re-runs fetch', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ ethereum: { usd: 100, usd_24h_change: 0 } }),
      })
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ ethereum: { usd: 200, usd_24h_change: 0 } }),
      })
    const { result } = renderHook(() => useTokenPrice('ethereum', 0))

    await waitFor(() => {
      expect(result.current.price?.usd).toBe(100)
    })
    result.current.refetch()
    await waitFor(() => {
      expect(result.current.price?.usd).toBe(200)
    })
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })
})

describe('usePairMarketPrice', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns null prices and never fetches for an unmapped pair (TKA/TKB)', async () => {
    const { result } = renderHook(() => usePairMarketPrice('TKA/TKB', 0))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.basePrice).toBeNull()
    expect(result.current.quotePrice).toBeNull()
    expect(result.current.error).toBeNull()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('returns base and quote prices for an explicitly mapped pair', async () => {
    // 第二十五轮起 ETH/USDT 已是静态登记（ethereum/tether），不再由测试临时写入；
    // 此处只验证该登记的读取行为，不再改写/删除映射。
    expect(PAIR_COINGECKO_IDS['ETH/USDT']).toEqual({ base: 'ethereum', quote: 'tether' })
    ;(globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            ethereum: { usd: 2000, usd_24h_change: 0 },
          }),
      })
      .mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            tether: { usd: 1, usd_24h_change: 0 },
          }),
      })
    const { result } = renderHook(() => usePairMarketPrice('ETH/USDT', 0))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.basePrice?.usd).toBe(2000)
    expect(result.current.quotePrice?.usd).toBe(1)
  })

  it('第二十五轮：7 个主流对登记为同名真实资产的 CoinGecko ID，TKA/TKB 仍无映射', () => {
    expect(PAIR_COINGECKO_IDS['BTC/USDT']).toEqual({ base: 'bitcoin', quote: 'tether' })
    expect(PAIR_COINGECKO_IDS['SOL/USDT']).toEqual({ base: 'solana', quote: 'tether' })
    expect(PAIR_COINGECKO_IDS['BNB/USDT']).toEqual({ base: 'binancecoin', quote: 'tether' })
    expect(PAIR_COINGECKO_IDS['XRP/USDT']).toEqual({ base: 'ripple', quote: 'tether' })
    expect(PAIR_COINGECKO_IDS['DOGE/USDT']).toEqual({ base: 'dogecoin', quote: 'tether' })
    expect(PAIR_COINGECKO_IDS['LINK/USDT']).toEqual({ base: 'chainlink', quote: 'tether' })
    expect(PAIR_COINGECKO_IDS['TKA/TKB']).toBeUndefined()
  })
})
