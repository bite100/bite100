/**
 * 奖励池余额（ContributorReward 合约持有的待分发资产）- 公开数据，任何人可见
 */
import { useEffect, useState } from 'react'
import { Contract, JsonRpcProvider } from 'ethers'
import {
  CONTRIBUTOR_REWARD_ADDRESS,
  TOKEN0_ADDRESS,
  TOKEN1_ADDRESS,
  ERC20_ABI,
  RPC_URL,
} from '../config'

interface RewardPoolBalance {
  eth: bigint
  token0: bigint
  token1: bigint
}

const REFRESH_MS = 30000

export function RewardPoolInfo() {
  const [balance, setBalance] = useState<RewardPoolBalance | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const provider = new JsonRpcProvider(RPC_URL)

    const fetchBalance = async () => {
      try {
        const ethBalance = await provider.getBalance(CONTRIBUTOR_REWARD_ADDRESS)
        const token0Contract = new Contract(TOKEN0_ADDRESS, ERC20_ABI, provider)
        const token1Contract = new Contract(TOKEN1_ADDRESS, ERC20_ABI, provider)
        const [token0Bal, token1Bal] = await Promise.all([
          token0Contract.balanceOf(CONTRIBUTOR_REWARD_ADDRESS),
          token1Contract.balanceOf(CONTRIBUTOR_REWARD_ADDRESS),
        ])
        if (!cancelled) {
          setBalance({
            eth: ethBalance,
            token0: token0Bal,
            token1: token1Bal,
          })
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '数据加载失败')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchBalance()
    const interval = setInterval(fetchBalance, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  if (loading && !balance) {
    return (
      <div className="card">
        <h3 className="card-title">贡献奖励池</h3>
        <p className="public-data-hint">加载中…</p>
      </div>
    )
  }

  if (error && !balance) {
    return (
      <div className="card">
        <h3 className="card-title">贡献奖励池</h3>
        <p className="public-data-hint muted">无法加载：{error}</p>
      </div>
    )
  }

  if (!balance) return null

  return (
    <div className="card">
      <h3 className="card-title">贡献奖励池</h3>
      <div className="fee-display-rows">
        <div className="fee-display-row">
          <span className="label">ETH</span>
          <span className="value">
            {(Number(balance.eth) / 1e18).toFixed(6)} ETH
          </span>
        </div>
        <div className="fee-display-row">
          <span className="label">TKA</span>
          <span className="value">
            {(Number(balance.token0) / 1e18).toLocaleString(undefined, {
              maximumFractionDigits: 2,
            })}{' '}
            TKA
          </span>
        </div>
        <div className="fee-display-row">
          <span className="label">TKB</span>
          <span className="value">
            {(Number(balance.token1) / 1e18).toLocaleString(undefined, {
              maximumFractionDigits: 2,
            })}{' '}
            TKB
          </span>
        </div>
      </div>
      <p className="public-data-hint">待分发的贡献奖励 · 公开数据，无需连接钱包</p>
    </div>
  )
}
