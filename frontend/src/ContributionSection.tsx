import { useState, useCallback } from 'react'
import { Contract } from 'ethers'
import {
  CONTRIBUTOR_REWARD_ADDRESS,
  CONTRIBUTOR_REWARD_ABI,
  TOKEN0_ADDRESS,
  TOKEN1_ADDRESS,
  CHAIN_ID,
} from './config'
import { getProvider, withSigner, formatTokenAmount, formatError, isValidAddress } from './utils'
import { getLastTwoPeriods, periodToId, isPastClaimDeadline, formatScore } from './services/contributorRewardUtils'

const ZERO = '0x0000000000000000000000000000000000000000'
const isRewardDeployed = () =>
  typeof CONTRIBUTOR_REWARD_ADDRESS === 'string' && CONTRIBUTOR_REWARD_ADDRESS.toLowerCase() !== ZERO

const explorerBase = CHAIN_ID === 1 ? 'https://etherscan.io' : CHAIN_ID === 137 ? 'https://polygonscan.com' : 'https://sepolia.etherscan.io'
const contributorRewardExplorerUrl = `${explorerBase}/address/${CONTRIBUTOR_REWARD_ADDRESS}`

export type PeriodRecord = {
  period: string
  score: string
  claimableT0: string
  claimableT1: string
  claimedT0: string
  claimedT1: string
}

export function ContributionSection({ account }: { account: string | null }) {
  const [queryAddress, setQueryAddress] = useState('')
  const [records, setRecords] = useState<PeriodRecord[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingClaim, setLoadingClaim] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fetchAll = useCallback(async () => {
    if (!isRewardDeployed()) return
    const addr = (queryAddress || account || '').trim()
    if (!isValidAddress(addr)) {
      setError(account ? '请输入有效的领奖地址（或留空使用当前账户）' : '请输入有效的领奖地址')
      return
    }
    setError(null)
    setLoading(true)
    setRecords(null)
    try {
      const provider = getProvider()
      if (!provider) throw new Error('未检测到钱包')
      const reward = new Contract(CONTRIBUTOR_REWARD_ADDRESS, CONTRIBUTOR_REWARD_ABI, provider)
      const periods = getLastTwoPeriods()
      const out: PeriodRecord[] = []
      for (const p of periods) {
        const pid = periodToId(p)
        const [score, claim0, claim1, claimed0, claimed1] = await Promise.all([
          reward.getContributionScore(p, addr),
          reward.claimable(p, TOKEN0_ADDRESS, addr),
          reward.claimable(p, TOKEN1_ADDRESS, addr),
          reward.claimed(pid, TOKEN0_ADDRESS, addr),
          reward.claimed(pid, TOKEN1_ADDRESS, addr),
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
      setRecords(out)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setLoading(false)
    }
  }, [account, queryAddress])

  const handleClaim = useCallback(async (period: string, token: 'T0' | 'T1') => {
    if (!account || !isRewardDeployed()) return
    const addr = (queryAddress || account || '').trim()
    if (addr.toLowerCase() !== account.toLowerCase()) return
    const tokenAddress = token === 'T0' ? TOKEN0_ADDRESS : TOKEN1_ADDRESS
    setError(null)
    setLoadingClaim(`${period}-${token}`)
    try {
      await withSigner(async (signer) => {
        const reward = new Contract(CONTRIBUTOR_REWARD_ADDRESS, CONTRIBUTOR_REWARD_ABI, signer)
        const tx = await reward.claimReward(period, tokenAddress)
        await tx.wait()
      })
      await fetchAll()
    } catch (e) {
      setError(formatError(e))
    } finally {
      setLoadingClaim(null)
    }
  }, [account, queryAddress, fetchAll])

  if (!isRewardDeployed()) return null

  const addr = (queryAddress || account || '').trim()
  const canClaimAny = account && addr.toLowerCase() === account.toLowerCase()

  return (
    <div className="card vault-section">
      <h2>贡献看板</h2>
      <p className="hint">
        输入领奖地址后点击「查询」。仅展示最近两个自然周（UTC）的记录：未领取奖励需在周期结束后 90 天内领取，逾期未领部分回流下一期奖池；已领取记录不受影响。领取需连接钱包，且查询地址须为当前账户。
      </p>
      <p className="hint" style={{ marginTop: '0.25rem', marginBottom: '0.5rem' }}>
        <a href={contributorRewardExplorerUrl} target="_blank" rel="noopener noreferrer">在区块浏览器查看贡献奖励合约</a>
      </p>
      <div className="input-row">
        <input
          type="text"
          placeholder={account ? `领奖地址（留空则用当前账户 ${account.slice(0, 8)}...）` : '领奖地址 0x...'}
          value={queryAddress}
          onChange={(e) => setQueryAddress(e.target.value)}
          className="input"
        />
      </div>
      <button
        className="btn secondary"
        onClick={fetchAll}
        disabled={loading}
      >
        {loading ? '查询中…' : '查询'}
      </button>

      {records && records.length > 0 && !error && (
        <div className="balances" style={{ marginTop: '1rem' }}>
          <p className="hint" style={{ marginBottom: '0.5rem' }}>最近两个周期</p>
          {records.map((r) => (
            <div key={r.period} className="card" style={{ marginBottom: '0.75rem', padding: '0.75rem' }}>
              <div className="row result">
                <span className="label">周期</span>
                <span className="value mono">{r.period}</span>
              </div>
              <div className="row result">
                <span className="label">贡献分</span>
                <span className="value mono">{r.score}</span>
              </div>
              <div className="row result">
                <span className="label">TKA 本次可领</span>
                <span className="value">{r.claimableT0}</span>
                {isPastClaimDeadline(r.period) && (
                  <span className="hint" style={{ marginLeft: '0.5rem' }}>已过领取期限，未领部分将回流下一期奖池</span>
                )}
                {canClaimAny && Number(r.claimableT0) > 0 && !isPastClaimDeadline(r.period) && (
                  <button
                    type="button"
                    className="btn primary"
                    style={{ marginLeft: '0.5rem' }}
                    disabled={loadingClaim !== null}
                    onClick={() => handleClaim(r.period, 'T0')}
                  >
                    {loadingClaim === `${r.period}-T0` ? '领取中…' : '领取 TKA'}
                  </button>
                )}
              </div>
              <div className="row result">
                <span className="label">TKA 已领取</span>
                <span className="value">{r.claimedT0}</span>
              </div>
              <div className="row result">
                <span className="label">TKB 本次可领</span>
                <span className="value">{r.claimableT1}</span>
                {isPastClaimDeadline(r.period) && (
                  <span className="hint" style={{ marginLeft: '0.5rem' }}>已过领取期限，未领部分将回流下一期奖池</span>
                )}
                {canClaimAny && Number(r.claimableT1) > 0 && !isPastClaimDeadline(r.period) && (
                  <button
                    type="button"
                    className="btn primary"
                    style={{ marginLeft: '0.5rem' }}
                    disabled={loadingClaim !== null}
                    onClick={() => handleClaim(r.period, 'T1')}
                  >
                    {loadingClaim === `${r.period}-T1` ? '领取中…' : '领取 TKB'}
                  </button>
                )}
              </div>
              <div className="row result">
                <span className="label">TKB 已领取</span>
                <span className="value">{r.claimedT1}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <p className="error" style={{ marginTop: '0.5rem', marginBottom: 0 }}>{error}</p>}
    </div>
  )
}
