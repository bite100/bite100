/**
 * 统一奖励领取入口：贡献奖励（ContributorReward）+ 手续费分成（FeeDistributor）领取，手机友好（大按钮、触控友好）
 */
import { useState, useCallback, useEffect } from 'react'
import { Contract } from 'ethers'
import {
  CONTRIBUTOR_REWARD_ADDRESS,
  CONTRIBUTOR_REWARD_ABI,
  FEE_DISTRIBUTOR_ADDRESS,
  FEE_DISTRIBUTOR_ABI,
  TOKEN0_ADDRESS,
  TOKEN1_ADDRESS,
} from '../config'
import { getProvider, withSigner, formatTokenAmount, formatError, isValidAddress } from '../utils'
import { getLastTwoPeriods, periodToId, isPastClaimDeadline, formatScore } from '../services/contributorRewardUtils'

const ZERO = '0x0000000000000000000000000000000000000000'
const isDeployed = () =>
  typeof CONTRIBUTOR_REWARD_ADDRESS === 'string' && CONTRIBUTOR_REWARD_ADDRESS.toLowerCase() !== ZERO
const isFeeDistDeployed = () =>
  typeof FEE_DISTRIBUTOR_ADDRESS === 'string' && FEE_DISTRIBUTOR_ADDRESS.toLowerCase() !== ZERO

export interface PeriodClaimRow {
  period: string
  score: string
  claimableT0: string
  claimableT1: string
  claimedT0: string
  claimedT1: string
}

export interface FeeDistClaimable {
  t0: string
  t1: string
}

interface UnifiedRewardClaimProps {
  account: string | null
  onError?: (msg: string | null) => void
}

export function UnifiedRewardClaim({ account, onError }: UnifiedRewardClaimProps) {
  const [rows, setRows] = useState<PeriodClaimRow[] | null>(null)
  const [feeDistClaimable, setFeeDistClaimable] = useState<FeeDistClaimable | null>(null)
  const [loading, setLoading] = useState(false)
  const [claiming, setClaiming] = useState<string | null>(null)
  const [claimingAll, setClaimingAll] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setErr = useCallback(
    (msg: string | null) => {
      setError(msg)
      onError?.(msg ?? null)
    },
    [onError]
  )

  const fetchData = useCallback(async () => {
    if ((!isDeployed() && !isFeeDistDeployed()) || !account || !isValidAddress(account)) {
      setRows(null)
      setFeeDistClaimable(null)
      return
    }
    setLoading(true)
    setErr(null)
    try {
      const provider = getProvider()
      if (!provider) throw new Error('未检测到钱包')
      const promises: Promise<unknown>[] = []
      if (isDeployed()) {
        const reward = new Contract(CONTRIBUTOR_REWARD_ADDRESS, CONTRIBUTOR_REWARD_ABI, provider)
        const periods = getLastTwoPeriods()
        for (const p of periods) {
          const pid = periodToId(p)
          promises.push(
            Promise.all([
              reward.getContributionScore(p, account),
              reward.claimable(p, TOKEN0_ADDRESS, account),
              reward.claimable(p, TOKEN1_ADDRESS, account),
              reward.claimed(pid, TOKEN0_ADDRESS, account),
              reward.claimed(pid, TOKEN1_ADDRESS, account),
            ]).then(([score, claim0, claim1, claimed0, claimed1]) => ({
              period: p,
              score: formatScore(score),
              claimableT0: formatTokenAmount(claim0 ?? 0n),
              claimableT1: formatTokenAmount(claim1 ?? 0n),
              claimedT0: formatTokenAmount(claimed0 ?? 0n),
              claimedT1: formatTokenAmount(claimed1 ?? 0n),
            }))
          )
        }
      }
      const feeDistPromise = isFeeDistDeployed()
        ? (async () => {
            const fd = new Contract(FEE_DISTRIBUTOR_ADDRESS, FEE_DISTRIBUTOR_ABI, provider)
            const [c0, c1] = await Promise.all([
              fd.claimable(TOKEN0_ADDRESS, account),
              fd.claimable(TOKEN1_ADDRESS, account),
            ])
            return { t0: formatTokenAmount(c0 ?? 0n), t1: formatTokenAmount(c1 ?? 0n) }
          })()
        : Promise.resolve(null)
      const [periodResults, fdResult] = await Promise.all([
        promises.length > 0 ? Promise.all(promises) : Promise.resolve([]),
        feeDistPromise,
      ])
      setRows(periodResults as PeriodClaimRow[])
      setFeeDistClaimable(fdResult)
    } catch (e) {
      setErr(formatError(e))
      setRows(null)
      setFeeDistClaimable(null)
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

  const handleClaimFeeDist = useCallback(
    async (token: 'T0' | 'T1') => {
      if (!account || !isFeeDistDeployed()) return
      const tokenAddress = token === 'T0' ? TOKEN0_ADDRESS : TOKEN1_ADDRESS
      const key = `feeDist-${token}`
      setClaiming(key)
      setErr(null)
      try {
        await withSigner(async (signer) => {
          const fd = new Contract(FEE_DISTRIBUTOR_ADDRESS, FEE_DISTRIBUTOR_ABI, signer)
          const tx = await fd.claim(tokenAddress)
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

  if (!isDeployed() && !isFeeDistDeployed()) return null

  if (!account) {
    return (
      <div className="card unified-reward-claim">
        <h3 className="card-title">统一奖励领取</h3>
        <p className="unified-reward-hint">连接钱包后可查看并领取贡献奖励与手续费分成。</p>
      </div>
    )
  }

  if (loading && !rows?.length && !feeDistClaimable) {
    return (
      <div className="card unified-reward-claim">
        <h3 className="card-title">统一奖励领取</h3>
        <p className="unified-reward-hint">加载中…</p>
      </div>
    )
  }

  const hasFeeDistClaim = feeDistClaimable && (Number(feeDistClaimable.t0) > 0 || Number(feeDistClaimable.t1) > 0)

  const claimableItems: { key: string; claim: () => Promise<void> }[] = []
  if (isFeeDistDeployed() && feeDistClaimable) {
    if (Number(feeDistClaimable.t0) > 0) claimableItems.push({ key: 'fd-T0', claim: () => handleClaimFeeDist('T0') })
    if (Number(feeDistClaimable.t1) > 0) claimableItems.push({ key: 'fd-T1', claim: () => handleClaimFeeDist('T1') })
  }
  if (rows) {
    for (const r of rows) {
      if (isPastClaimDeadline(r.period)) continue
      if (Number(r.claimableT0) > 0) claimableItems.push({ key: `${r.period}-T0`, claim: () => handleClaim(r.period, 'T0') })
      if (Number(r.claimableT1) > 0) claimableItems.push({ key: `${r.period}-T1`, claim: () => handleClaim(r.period, 'T1') })
    }
  }
  const handleClaimAll = async () => {
    if (claimableItems.length === 0 || claiming !== null || claimingAll) return
    setClaimingAll(true)
    setErr(null)
    try {
      for (const item of claimableItems) {
        await item.claim()
      }
    } catch (e) {
      setErr(formatError(e))
    } finally {
      setClaimingAll(false)
    }
  }

  return (
    <div className="card unified-reward-claim">
      <h3 className="card-title">奖励领取</h3>
      <p className="unified-reward-hint">可领奖励一键领取，或在下方分项领取。</p>

      {claimableItems.length > 0 && (
        <button
          type="button"
          className="btn primary claim-all-btn"
          disabled={claiming !== null || claimingAll}
          onClick={handleClaimAll}
        >
          {claimingAll ? '领取中…' : `一键领取全部（${claimableItems.length} 项）`}
        </button>
      )}

      {isFeeDistDeployed() && feeDistClaimable && (
        <div className="unified-reward-period-card">
          <div className="unified-reward-period-label">手续费分成</div>
          <div className="unified-reward-period-row">
            <span className="label">TKA 可领</span>
            <span className="value">{feeDistClaimable.t0}</span>
          </div>
          <button
            type="button"
            className="btn primary claim-btn-large"
            disabled={Number(feeDistClaimable.t0) <= 0 || claiming !== null}
            onClick={() => handleClaimFeeDist('T0')}
          >
            {claiming === 'feeDist-T0' ? '领取中…' : '领取 TKA'}
          </button>
          <div className="unified-reward-period-row">
            <span className="label">TKB 可领</span>
            <span className="value">{feeDistClaimable.t1}</span>
          </div>
          <button
            type="button"
            className="btn primary claim-btn-large"
            disabled={Number(feeDistClaimable.t1) <= 0 || claiming !== null}
            onClick={() => handleClaimFeeDist('T1')}
          >
            {claiming === 'feeDist-T1' ? '领取中…' : '领取 TKB'}
          </button>
        </div>
      )}

      {rows && rows.length > 0 ? (
        <div className="unified-reward-periods">
          {rows.map((r) => {
            const pastDeadline = isPastClaimDeadline(r.period)
            const canClaimT0 = !pastDeadline && Number(r.claimableT0) > 0
            const canClaimT1 = !pastDeadline && Number(r.claimableT1) > 0
            return (
              <div key={r.period} className="unified-reward-period-card">
                <div className="unified-reward-period-label">贡献奖励 · {r.period}</div>
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
        !loading && !hasFeeDistClaim && <p className="unified-reward-hint muted">暂无贡献奖励或手续费分成可领，请先参与贡献。</p>
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
