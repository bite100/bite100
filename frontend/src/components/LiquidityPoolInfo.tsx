/**
 * 流动性池余额与 TVL - 公开数据，任何人可见（使用公共 RPC，无需钱包）
 */
import { useEffect, useState } from 'react'
import { Contract, JsonRpcProvider } from 'ethers'
import { AMM_POOL_ADDRESS, AMM_ABI, RPC_URL } from '../config'
import { usePairMarketPrice } from '../hooks/useTokenPrice'

interface Reserves {
  reserve0: bigint
  reserve1: bigint
}

const REFRESH_MS = 10000

export function LiquidityPoolInfo() {
  const [reserves, setReserves] = useState<Reserves | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { basePrice, quotePrice } = usePairMarketPrice('TKA/TKB', REFRESH_MS)

  useEffect(() => {
    let cancelled = false
    const provider = new JsonRpcProvider(RPC_URL)

    const fetchReserves = async () => {
      try {
        const contract = new Contract(AMM_POOL_ADDRESS, AMM_ABI, provider)
        const [reserve0, reserve1] = await Promise.all([
          contract.reserve0(),
          contract.reserve1(),
        ])
        if (!cancelled) {
          setReserves({ reserve0, reserve1 })
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '获取失败')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchReserves()
    const interval = setInterval(fetchReserves, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  const tvl =
    reserves && basePrice && quotePrice
      ? (Number(reserves.reserve0) / 1e18) * basePrice.usd +
        (Number(reserves.reserve1) / 1e18) * quotePrice.usd
      : 0

  if (loading && !reserves) {
    return (
      <div className="card">
        <h3 className="card-title">流动性池余额</h3>
        <p className="public-data-hint">加载中…</p>
      </div>
    )
  }

  if (error && !reserves) {
    return (
      <div className="card">
        <h3 className="card-title">流动性池余额</h3>
        <p className="public-data-hint muted">无法加载：{error}</p>
      </div>
    )
  }

  if (!reserves) return null

  return (
    <div className="card">
      <h3 className="card-title">流动性池余额</h3>
      <div className="fee-display-rows">
        <div className="fee-display-row">
          <span className="label">TKA (Token A)</span>
          <span className="value">
            {(Number(reserves.reserve0) / 1e18).toLocaleString(undefined, {
              maximumFractionDigits: 2,
            })}{' '}
            TKA
          </span>
        </div>
        <div className="fee-display-row">
          <span className="label">TKB (Token B)</span>
          <span className="value">
            {(Number(reserves.reserve1) / 1e18).toLocaleString(undefined, {
              maximumFractionDigits: 2,
            })}{' '}
            TKB
          </span>
        </div>
        {tvl > 0 && (
          <div className="fee-display-row highlight">
            <span className="label">总价值锁定 (TVL)</span>
            <span className="value">${tvl.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
          </div>
        )}
      </div>
      <p className="public-data-hint">📊 公开数据，任何人可见 · 每 10 秒自动刷新</p>
    </div>
  )
}
