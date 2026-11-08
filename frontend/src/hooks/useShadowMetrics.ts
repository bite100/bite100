/**
 * 第 34 轮（无节点阶段 2）影子指标 hook：
 * RELAY_MODE=disabled 时完全不工作（不拉任何源，生产零变化）；
 * shadow / active 时按 30 秒轮询对全部登记交易对跑一轮双读，
 * 纵向观察器（首次发现时间、三源可用率）在 hook 生命周期内累计。
 * 合并视图是否进入生产订单簿展示由 mode 决定——本 hook 只产出数据，
 * shadow 下订单簿仍走节点单读（hooks/useNodeOrderBook 不受影响）。
 */
import { useEffect, useRef, useState } from 'react'
import { CHAIN_ID } from '../config'
import { TRADE_PAIRS } from '../config/pairs'
import { RELAY_MODE } from '../config/relay'
import {
  ShadowObserver,
  runDualReadRound,
  type DualReadRound,
} from '../services/dualread'

export function useShadowMetrics(pollMs = 30_000): {
  mode: typeof RELAY_MODE
  round: DualReadRound | null
  running: boolean
} {
  const [round, setRound] = useState<DualReadRound | null>(null)
  const [running, setRunning] = useState(false)
  const observerRef = useRef<ShadowObserver | null>(null)
  if (!observerRef.current) observerRef.current = new ShadowObserver()

  useEffect(() => {
    if (RELAY_MODE === 'disabled') return
    let cancelled = false
    const tick = async () => {
      if (!cancelled) setRunning(true)
      try {
        const r = await runDualReadRound(
          { mode: RELAY_MODE, observer: observerRef.current! },
          CHAIN_ID,
          [...TRADE_PAIRS],
        )
        if (!cancelled) setRound(r)
      } catch {
        // runDualReadRound 内部已逐源降级；走到这里的是未预期异常，保持上一轮数据
      } finally {
        if (!cancelled) setRunning(false)
      }
    }
    tick()
    const id = setInterval(tick, pollMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [pollMs])

  return { mode: RELAY_MODE, round, running }
}
