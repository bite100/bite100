/**
 * 统一奖励领取入口：贡献奖励（ContributorReward）领取，手机友好（大按钮、触控友好）
 */
import { useState, useCallback, useEffect } from 'react'
import { Contract } from 'ethers'
import {
  CONTRIBUTOR_REWARD_ADDRESS,
  CONTRIBUTOR_REWARD_ABI,
  TOKEN0_ADDRESS,
  TOKEN1_ADDRESS,
} from '../config'
import { getProvider, withSigner, formatTokenAmount, formatError, isValidAddress } from '../utils'
import { getLastTwoPeriods, periodToId, isPastClaimDeadline, formatScore } from '../services/contributorRewardUtils'

const ZERO = '0x0000000000000000000000000000000000000000'
const isDeployed = () =>
  typeof CONTRIBUTOR_REWARD_ADDRESS === 'string' && CONTRIBUTOR_REWARD_ADDRESS.toLowerCase() !== ZERO

export interface PeriodClaimRow {
  period: string
  score: string
  claimableT0: string
  claimableT1: string
  claimedT0: string
  claimedT1: string
}

interface UnifiedRewardClaimProps {
  account: string | null
  onError?: (msg: string | null) => void
}

export function UnifiedRewardClaim({ account, onError }: UnifiedRewardClaimProps) {
  const [rows, setRows] = useState<PeriodClaimRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [claiming, setClaiming] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const setErr = useCallback(
    (msg: string | null) => {
      setError(msg)
      onError?.(msg ?? null)
    },
    [onError]
  )

  const fetchData = useCallback(async () => {
    if (!isDeployed() || !account || !isValidAddress(account)) {
      setRows(null)
      return
    }
    setLoading(true)
    setErr(null)
    try {
      const provider = getProvider()
      if (!provider) throw new Error('未检测到钱包')
      const reward = new Contract(CONTRIBUTOR_REWARD_ADDRESS, CONTRIBUTOR_REWARD_ABI, provider)
      const periods = getLastTwoPeriods()
      const out: PeriodClaimRow[] = []
      for (const p of periods) {
        const pid = periodToId(p)
        const [score, claim0, claim1, claimed0, claimed1] = await Promise.all([
          reward.getContributionScore(p, account),
          reward.claimable(p, TOKEN0_ADDRESS, account),
          reward.claimable(p, TOKEN1_ADDRESS, account),
          reward.claimed(pid, TOKEN0_ADDRESS, account),
          reward.claimed(pid, TOKEN1_ADDRESS, account),
        ])
        out.push({
          period: p,
          score: formatScore(score),
          claimableT0: formatTokenAmount(claim0 ?? 0n),
          claimableT1: formatTokenAmount(claim1 ?? 0n),
          claimedT0: formatTokenAmount(claimed0 ?? 0n),
          claimedT1: formatTokenAmount(claimed1 ?? 0n),
        })
      }
      setRows(out)
    } catch (e) {
      setErr(formatError(e))
      setRows(null)
    } finally {
      setLoading(false)
    }
  }, [account, setErr])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleClaim = useCallback(
    async (period: string, token: 'T0' | 'T1') => {
      if (!account || !isDeployed()) return
      const tokenAddress = token === 'T0' ? TOKEN0_ADDRESS : TOKEN1_ADDRESS
      const key = `${period}-${token}`
      setClaiming(key)
      setErr(null)
      try {
        await withSigner(async (signer) => {
          const reward = new Contract(CONTRIBUTOR_REWARD_ADDRESS, CONTRIBUTOR_REWARD_ABI, signer)
          const tx = await reward.claimReward(period, tokenAddress)
          await tx.wait()
        })
        await fetchData()
      } catch (e) {
        setErr(formatError(e))
      } finally {
        setClaiming(null)
      }
    },
    [account, fetchData, setErr]
  )

  if (!isDeployed()) return null

  if (!account) {
    return (
      <div className="card unified-reward-claim">
        <h3 className="card-title">贡献奖励领取</h3>
        <p className="unified-reward-hint">连接钱包后可查看并领取贡献奖励（按周期 TKA/TKB 分别领取）。</p>
      </div>
    )
  }

  if (loading && !rows?.length) {
    return (
      <div className="card unified-reward-claim">
        <h3 className="card-title">贡献奖励领取</h3>
        <p className="unified-reward-hint">加载中…</p>
      </div>
    )
  }

  return (
    <div className="card unified-reward-claim">
      <h3 className="card-title">贡献奖励领取</h3>
      <p className="unified-reward-hint">按周期领取，每周期 TKA / TKB 各领取一次。周期结束超过 14 天未领取将不再发放。</p>

      {rows && rows.length > 0 ? (
        <div className="unified-reward-periods">
          {rows.map((r) => {
            const pastDeadline = isPastClaimDeadline(r.period)
            const canClaimT0 = !pastDeadline && Number(r.claimableT0) > 0
            const canClaimT1 = !pastDeadline && Number(r.claimableT1) > 0
            return (
              <div key={r.period} className="unified-reward-period-card">
                <div className="unified-reward-period-label">{r.period}</div>
                <div className="unified-reward-period-row">
                  <span className="label">TKA 可领</span>
                  <span className="value">{r.claimableT0}</span>
                </div>
                {pastDeadline && Number(r.claimableT0) > 0 ? (
                  <p className="unified-reward-deadline">已过领取期限</p>
                ) : (
                  <button
                    type="button"
                    className="btn primary claim-btn-large"
                    disabled={!canClaimT0 || claiming !== null}
                    onClick={() => handleClaim(r.period, 'T0')}
                  >
                    {claiming === `${r.period}-T0` ? '领取中…' : '领取 TKA'}
                  </button>
                )}
                <div className="unified-reward-period-row">
                  <span className="label">TKB 可领</span>
                  <span className="value">{r.claimableT1}</span>
                </div>
                {pastDeadline && Number(r.claimableT1) > 0 ? (
                  <p className="unified-reward-deadline">已过领取期限</p>
                ) : (
                  <button
                    type="button"
                    className="btn primary claim-btn-large"
                    disabled={!canClaimT1 || claiming !== null}
                    onClick={() => handleClaim(r.period, 'T1')}
                  >
                    {claiming === `${r.period}-T1` ? '领取中…' : '领取 TKB'}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        !loading && <p className="unified-reward-hint muted">暂无最近两周的领取记录，请先参与贡献。</p>
      )}

      {rows && rows.length > 0 && (
        <button type="button" className="btn secondary unified-reward-refresh" onClick={fetchData} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      )}

      {error && (
        <p className="unified-reward-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
