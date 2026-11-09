/**
 * 交易对解析 hook（第六十轮）：种子对同步直解；自助上架对（地址型键）先查
 * pairRegistry 模块缓存，未命中时触发一次注册表拉取后重解。解析不到
 * （未登记/错链/注册表还没拉到）返回 null，调用方据此禁用下单并如实提示。
 */
import { useEffect, useState } from 'react'
import {
  fetchListedPairs,
  isListedPairKey,
  resolvePair,
  type ResolvedPair,
} from '../services/pairRegistry'

export function useResolvedPair(chainId: number, pair: string): ResolvedPair | null {
  const [resolved, setResolved] = useState<ResolvedPair | null>(() => resolvePair(chainId, pair))

  useEffect(() => {
    const immediate = resolvePair(chainId, pair)
    setResolved(immediate)
    if (immediate || !isListedPairKey(pair)) return
    let cancelled = false
    fetchListedPairs(chainId)
      .then(() => {
        if (!cancelled) setResolved(resolvePair(chainId, pair))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [chainId, pair])

  return resolved
}
