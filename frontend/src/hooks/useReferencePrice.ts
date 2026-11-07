/**
 * 参考价 hook（第二十三轮）：对 services/referencePrice 的解析逻辑做 React 封装。
 * - 链与下单面板的合约地址口径一致（config.ts 的静态 CHAIN_ID），喂价经该链公开 RPC 直读，
 *   不依赖钱包连接（未连接钱包也能看参考价）；
 * - 喂价读数缓存 30 秒：盘口高频刷新不会反复打 RPC；
 * - 每 60 秒重估一次，让「数据过期」判定随时间流逝自动生效。
 */
import { useEffect, useRef, useState } from 'react'
import { CHAIN_ID } from '../config'
import {
  readChainlinkFeed,
  resolveReferencePrice,
  type FeedReading,
  type ReferencePriceResult,
} from '../services/referencePrice'
import type { MarketBookLevel } from '../components/dashboard/marketOrder'

const FEED_CACHE_MS = 30_000
const REEVALUATE_MS = 60_000

export type UseReferencePriceResult = ReferencePriceResult | { status: 'loading' }

export interface ReferencePriceFallbackInput {
  lastTradePrice: number | null
  lastTradeAtSec: number | null
  book?: { bids: MarketBookLevel[]; asks: MarketBookLevel[] }
}

export function useReferencePrice(
  pair: string,
  fallback: ReferencePriceFallbackInput
): UseReferencePriceResult {
  const [result, setResult] = useState<UseReferencePriceResult>({ status: 'loading' })
  const cacheRef = useRef<{ key: string; atMs: number; reading: FeedReading } | null>(null)

  const { lastTradePrice, lastTradeAtSec, book } = fallback
  const bids = book?.bids
  const asks = book?.asks

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const res = await resolveReferencePrice(
        CHAIN_ID,
        pair,
        { lastTradePrice, lastTradeAtSec, bids, asks },
        {
          nowSec: () => Math.floor(Date.now() / 1000),
          readFeed: async (chainId, address) => {
            const key = `${chainId}:${address}`
            const cache = cacheRef.current
            if (cache && cache.key === key && Date.now() - cache.atMs < FEED_CACHE_MS) {
              return cache.reading
            }
            const reading = await readChainlinkFeed(chainId, address)
            cacheRef.current = { key, atMs: Date.now(), reading }
            return reading
          },
        }
      )
      if (!cancelled) setResult(res)
    }
    run()
    const timer = setInterval(run, REEVALUATE_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [pair, lastTradePrice, lastTradeAtSec, bids, asks])

  return result
}
