import { useState, useEffect } from 'react'
import { getProvider } from '../utils'

/** 典型 settleTrade 调用的 Gas 上限（用于估算展示） */
const SETTLE_TRADE_GAS_LIMIT = 200000n

export interface GasEstimate {
  gasLimit: bigint
  gasPrice: bigint
  totalCost: bigint
}

/**
 * 估算当前链上 Gas 费用（用于手续费透明化展示）。
 * 使用固定 gasLimit 与当前 gasPrice，不发起真实交易。
 */
export function useGasEstimate(enabled: boolean = true) {
  const [estimate, setEstimate] = useState<GasEstimate | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    const run = async () => {
      try {
        setLoading(true)
        setError(null)
        const provider = getProvider()
        if (!provider) {
          throw new Error('未检测到钱包或网络')
        }
        const feeData = await provider.getFeeData()
        const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n
        if (cancelled) return
        setEstimate({
          gasLimit: SETTLE_TRADE_GAS_LIMIT,
          gasPrice,
          totalCost: SETTLE_TRADE_GAS_LIMIT * gasPrice,
        })
      } catch (err) {
        if (!cancelled) {
          console.error('Gas 估算失败:', err)
          setError(err instanceof Error ? err : new Error('Gas 估算失败'))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    return () => { cancelled = true }
  }, [enabled])

  return { estimate, loading, error }
}
