/**
 * 创始人奖励（NodeRewards）：仅创始人在项目刚上线时领取一次，普通用户无需操作
 */
import { useEffect, useState, useCallback } from 'react'
import { Contract, formatUnits } from 'ethers'
import { NODE_REWARDS_ADDRESS, NODE_REWARDS_ABI } from '../config'
import { getProvider, withSigner, formatError, isValidAddress } from '../utils'

interface NodeLaunchRewardsProps {
  account: string | null
}

export function NodeLaunchRewards({ account }: NodeLaunchRewardsProps) {
  const [devPoints, setDevPoints] = useState<bigint>(0n)
  const [totalPoints, setTotalPoints] = useState<bigint>(0n)
  const [loading, setLoading] = useState(false)
  const [claiming, setClaiming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!NODE_REWARDS_ADDRESS || !isValidAddress(NODE_REWARDS_ADDRESS)) {
    return null
  }

  const fetchData = useCallback(async () => {
    if (!account || !isValidAddress(account)) {
      setDevPoints(0n)
      setTotalPoints(0n)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const provider = getProvider()
      if (!provider) throw new Error('未检测到钱包')
      const c = new Contract(NODE_REWARDS_ADDRESS, NODE_REWARDS_ABI, provider)
      const [dp, total] = await Promise.all([
        c.devPoints(account) as Promise<bigint>,
        c.getTotalRewards(account) as Promise<bigint>,
      ])
      setDevPoints(dp ?? 0n)
      setTotalPoints(total ?? 0n)
    } catch (e) {
      setError(formatError(e))
      setDevPoints(0n)
      setTotalPoints(0n)
    } finally {
      setLoading(false)
    }
  }, [account])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleClaim = async () => {
    if (!account || !isValidAddress(account) || totalPoints === 0n) return
    setClaiming(true)
    setError(null)
    try {
      await withSigner(async (signer) => {
        const c = new Contract(NODE_REWARDS_ADDRESS, NODE_REWARDS_ABI, signer)
        const tx = await c.claimRewards()
        await tx.wait()
      })
      await fetchData()
    } catch (e) {
      setError(formatError(e))
    } finally {
      setClaiming(false)
    }
  }

  if (!account) return null

  const totalUsdt = totalPoints // 1 积分 = 1 USDT（整数）

  return (
    <div className="card unified-reward-claim">
      <h3 className="card-title">创始人奖励</h3>
      <p className="unified-reward-hint">
        仅项目创始人在主网刚上线时领取一次，用于回收前期投入；普通用户无需操作。
      </p>

      <div className="unified-reward-period-row">
        <span className="label">创始人积分</span>
        <span className="value">{formatUnits(devPoints, 0)} 积分</span>
      </div>
      <div className="unified-reward-period-row">
        <span className="label">合计</span>
        <span className="value strong">{formatUnits(totalUsdt, 0)} 积分 ≈ {formatUnits(totalUsdt, 0)} USDT</span>
      </div>

      <button
        type="button"
        className="btn primary claim-all-btn"
        disabled={claiming || totalPoints === 0n}
        onClick={handleClaim}
      >
        {claiming ? '领取中…' : totalPoints === 0n ? '暂无创始人奖励' : '一键领取创始人奖励'}
      </button>

      {loading && <p className="unified-reward-hint">加载上线奖励信息中…</p>}
      {error && (
        <p className="unified-reward-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

