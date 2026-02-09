/**
 * 价格参考集成：从 CoinGecko 获取市场参考价，用于订单簿/下单表单展示
 * 突出「P2P 零滑点限价单 vs 主流 AMM 滑点」
 */
import { useState, useEffect, useCallback } from 'react'

export interface TokenPrice {
  usd: number
  usd_24h_change: number
}

export interface UseTokenPriceResult {
  price: TokenPrice | null
  loading: boolean
  error: Error | null
  refetch: () => void
}

const COINGECKO_API = 'https://api.coingecko.com/api/v3/simple/price'

/**
 * 获取单个代币价格（CoinGecko 免费 API，有速率限制）
 * @param tokenId CoinGecko 代币 ID（如 'ethereum', 'tether'）
 * @param refreshIntervalMs 刷新间隔（毫秒），默认 30 秒；0 表示不轮询
 */
export function useTokenPrice(
  tokenId: string,
  refreshIntervalMs: number = 30000
): UseTokenPriceResult {
  const [price, setPrice] = useState<TokenPrice | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const fetchPrice = useCallback(async () => {
    if (!tokenId) {
      setLoading(false)
      return
    }
    try {
      setLoading(true)
      setError(null)
      const url = `${COINGECKO_API}?ids=${encodeURIComponent(tokenId)}&vs_currencies=usd&include_24hr_change=true`
      const res = await fetch(url)
      const data = await res.json()
      const item = data[tokenId]
      if (item != null) {
        setPrice({
          usd: Number(item.usd) || 0,
          usd_24h_change: Number(item.usd_24h_change) ?? 0,
        })
      } else {
        setError(new Error(`Token ${tokenId} not found`))
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch price'))
    } finally {
      setLoading(false)
    }
  }, [tokenId])

  useEffect(() => {
    fetchPrice()
    if (refreshIntervalMs > 0) {
      const t = setInterval(fetchPrice, refreshIntervalMs)
      return () => clearInterval(t)
    }
  }, [fetchPrice, refreshIntervalMs])

  return { price, loading, error, refetch: fetchPrice }
}

/** 交易对对应的 CoinGecko ID（用于显示市场参考价；测试网代币可用主网等价物代替） */
export const PAIR_COINGECKO_IDS: Record<string, { base: string; quote: string }> = {
  'TKA/TKB': { base: 'ethereum', quote: 'tether' },
  'TKB/TKA': { base: 'tether', quote: 'ethereum' },
}

export function usePairMarketPrice(
  pair: string,
  refreshIntervalMs: number = 30000
): {
  basePrice: TokenPrice | null
  quotePrice: TokenPrice | null
  loading: boolean
  error: Error | null
} {
  const ids = PAIR_COINGECKO_IDS[pair] ?? { base: 'ethereum', quote: 'tether' }
  const base = useTokenPrice(ids.base, refreshIntervalMs)
  const quote = useTokenPrice(ids.quote, refreshIntervalMs)
  return {
    basePrice: base.price,
    quotePrice: quote.price,
    loading: base.loading || quote.loading,
    error: base.error ?? quote.error,
  }
}
