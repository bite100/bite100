/**
 * 当前交易对 hook（第二十五轮）：
 * 交易对状态与 URL ?pair= 参数双向同步——刷新/分享链接后仍是同一交易对；
 * 切换交易对时改写 URL（replaceState，不产生多余历史记录），交易台各组件
 * （统计/K 线/订单簿/下单/最新成交）随同一 pair 值切换。
 */
import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_PAIR, isTradePair, pairFromSearch, type TradePair } from '../config/pairs'

export function useCurrentPair(): {
  pair: TradePair
  setPair: (pair: TradePair) => void
} {
  const [pair, setPairState] = useState<TradePair>(() =>
    typeof window === 'undefined' ? DEFAULT_PAIR : pairFromSearch(window.location.search)
  )

  const setPair = useCallback((next: TradePair) => {
    if (!isTradePair(next)) return
    setPairState(next)
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href)
      url.searchParams.set('pair', next)
      window.history.replaceState(null, '', url.toString())
    }
  }, [])

  // 浏览器前进/后退时按 URL 恢复交易对
  useEffect(() => {
    const onPopState = () => {
      setPairState(pairFromSearch(window.location.search))
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  return { pair, setPair }
}
