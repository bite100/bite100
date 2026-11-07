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
    PAIR_COINGECKO_IDS['ETH/USDT'] = { base: 'ethereum', quote: 'tether' }
    try {
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
    } finally {
      delete PAIR_COINGECKO_IDS['ETH/USDT']
    }
  })
})
