/**
 * 自助上架对列表 hook（第六十轮）：从中继注册表拉当前链的自助上架对
 * （services/pairRegistry.fetchListedPairs，模块级缓存 + 在飞去重）。
 * 中继不可达时 pairs 为空数组、failed 为 true，界面只显示种子对，不崩。
 */
import { useCallback, useEffect, useState } from 'react'
import { fetchListedPairs, type ListedPair } from '../services/pairRegistry'

export interface UseListedPairsState {
  pairs: ListedPair[]
  loading: boolean
  failed: boolean
  refresh: () => void
}

export function useListedPairs(chainId: number): UseListedPairsState {
  const [pairs, setPairs] = useState<ListedPair[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchListedPairs(chainId, { force: tick > 0 })
      .then((rows) => {
        if (cancelled) return
        setPairs(rows)
        setFailed(false)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setFailed(true)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [chainId, tick])

  return { pairs, loading, failed, refresh }
}
