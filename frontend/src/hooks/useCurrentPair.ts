/**
 * 当前交易对 hook（第二十五轮；第六十轮放宽）：
 * 交易对状态与 URL ?pair= 参数双向同步——刷新/分享链接后仍是同一交易对；
 * 切换交易对时改写 URL（replaceState，不产生多余历史记录），交易台各组件
 * （统计/K 线/订单簿/下单/最新成交）随同一 pair 值切换。
 * 第六十轮起 pair 不限于种子符号键：自助上架的地址型键（链号须与当前链
 * 一致）同样可作为当前对；是否已登记由 pairRegistry 解析层在运行时判定。
 */
import { useCallback, useEffect, useState } from 'react'
import { CHAIN_ID } from '../config'
import { DEFAULT_PAIR, isSelectablePair, pairFromSearchAny } from '../config/pairs'

export function useCurrentPair(): {
  pair: string
  setPair: (pair: string) => void
} {
  const [pair, setPairState] = useState<string>(() =>
    typeof window === 'undefined' ? DEFAULT_PAIR : pairFromSearchAny(window.location.search, CHAIN_ID)
  )

  const setPair = useCallback((next: string) => {
    if (!isSelectablePair(next, CHAIN_ID)) return
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
      setPairState(pairFromSearchAny(window.location.search, CHAIN_ID))
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  return { pair, setPair }
}
