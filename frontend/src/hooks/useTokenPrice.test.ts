/**
 * useTokenPrice / usePairMarketPrice 单元测试（mock fetch）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { act } from 'react'
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

  it('第54轮：请求挂死时 8 秒超时 abort 并落到 error，不再永远 loading', async () => {
    vi.useFakeTimers()
    try {
      // fetch 永不主动返回，只在 abort 时 reject（模拟对端不回）
      ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
        (_url: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })),
            )
          }),
      )
      const { result } = renderHook(() => useTokenPrice('ethereum', 0))
      expect(result.current.loading).toBe(true)
      await act(async () => {
        vi.advanceTimersByTime(8000)
      })
      expect(result.current.loading).toBe(false)
      expect(result.current.error).not.toBeNull()
      expect(result.current.price).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('第54轮：上一笔请求在飞时 refetch 跳过，不叠加请求', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise(() => {}), // 永不落定
    )
    const { result } = renderHook(() => useTokenPrice('ethereum', 0))
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    result.current.refetch()
    result.current.refetch()
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('第58轮：切换 token 时旧请求迟到返回不得写入新 token 的价格', async () => {
    let resolveOld: (v: unknown) => void = () => {}
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      (url: unknown) => {
        if (String(url).includes('ids=bitcoin')) {
          return new Promise((resolve) => {
            resolveOld = resolve
          })
        }
        return Promise.resolve({
          json: () =>
            Promise.resolve({ ethereum: { usd: 3000, usd_24h_change: 2 } }),
        })
      },
    )
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useTokenPrice(id, 0),
      { initialProps: { id: 'bitcoin' } },
    )
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    // 旧请求未回时切换 token：新请求应立即发出，不被旧在飞挡住
    rerender({ id: 'ethereum' })
    await waitFor(() => {
      expect(result.current.price?.usd).toBe(3000)
    })
    // 旧 bitcoin 请求迟到返回（50000）：绝不能覆盖当前 ethereum 的价格
    await act(async () => {
      resolveOld({
        json: () =>
          Promise.resolve({ bitcoin: { usd: 50000, usd_24h_change: 9 } }),
      })
    })
    expect(result.current.price?.usd).toBe(3000)
    expect(result.current.error).toBeNull()
  })

  it('第59轮：切换 token 后旧请求迟到「失败」不得污染新 token 的 error 状态', async () => {
    // 与上一条迟到成功用例镜像：r58 只钉了迟到成功不覆写 price；
    // 迟到失败若不被 isCurrent 守卫拦住，会把新 token 的面板打成
    // 报错态（实现 catch 分支同样过 isCurrent，本测试钉住这条路径）
    let rejectOld: (e: unknown) => void = () => {}
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      (url: unknown) => {
        if (String(url).includes('ids=bitcoin')) {
          return new Promise((_resolve, reject) => {
            rejectOld = reject
          })
        }
        return Promise.resolve({
          json: () =>
            Promise.resolve({ ethereum: { usd: 3000, usd_24h_change: 2 } }),
        })
      },
    )
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useTokenPrice(id, 0),
      { initialProps: { id: 'bitcoin' } },
    )
    rerender({ id: 'ethereum' })
    await waitFor(() => {
      expect(result.current.price?.usd).toBe(3000)
    })
    expect(result.current.error).toBeNull()
    // 旧 bitcoin 请求此刻才失败：新 token 的 error/price 都不得被动
    await act(async () => {
      rejectOld(new Error('network down'))
    })
    expect(result.current.error).toBeNull()
    expect(result.current.price?.usd).toBe(3000)
    expect(result.current.loading).toBe(false)
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
