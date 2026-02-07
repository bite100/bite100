import { useState, useCallback } from 'react'
import { Contract, solidityPackedKeccak256 } from 'ethers'
import {
  CONTRIBUTOR_REWARD_ADDRESS,
  CONTRIBUTOR_REWARD_ABI,
  TOKEN0_ADDRESS,
  TOKEN1_ADDRESS,
  CHAIN_ID,
} from './config'
import { getProvider, withSigner, formatTokenAmount, formatError, isValidAddress } from './utils'

const ZERO = '0x0000000000000000000000000000000000000000'
const isRewardDeployed = () =>
  typeof CONTRIBUTOR_REWARD_ADDRESS === 'string' && CONTRIBUTOR_REWARD_ADDRESS.toLowerCase() !== ZERO

const explorerBase = CHAIN_ID === 1 ? 'https://etherscan.io' : CHAIN_ID === 137 ? 'https://polygonscan.com' : 'https://sepolia.etherscan.io'
const contributorRewardExplorerUrl = `${explorerBase}/address/${CONTRIBUTOR_REWARD_ADDRESS}`

/** 贡献分为 1e18 精度，格式化为可读小数 */
function formatScore(raw: string | bigint | undefined): string {
  if (raw == null || raw === '') return '0'
  try {
    const n = typeof raw === 'string' ? BigInt(raw) : raw
    return (Number(n) / 1e18).toFixed(6)
  } catch {
    return String(raw)
  }
}

/** 最近两周（UTC 自然周）：[本周, 上周] */
function getLastTwoPeriods(): string[] {
  const toYMD = (d: Date) => d.toISOString().slice(0, 10)
  const now = new Date()
  const utcMon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const day = now.getUTCDay()
  const daysSinceMon = (day + 6) % 7
  utcMon.setUTCDate(utcMon.getUTCDate() - daysSinceMon)
  const end = new Date(utcMon)
  end.setUTCDate(end.getUTCDate() + 6)
  const current = `${toYMD(utcMon)}_${toYMD(end)}`
  const prevMon = new Date(utcMon)
  prevMon.setUTCDate(prevMon.getUTCDate() - 7)
  const prevEnd = new Date(prevMon)
  prevEnd.setUTCDate(prevEnd.getUTCDate() + 6)
  const previous = `${toYMD(prevMon)}_${toYMD(prevEnd)}`
  return [current, previous]
}

/** 与合约 _periodId 一致：keccak256(abi.encodePacked(period)) */
function periodToId(period: string): string {
  return solidityPackedKeccak256(['string'], [period])
}

/** 周期字符串格式 YYYY-MM-DD_YYYY-MM-DD，取结束日 UTC 0 点 + 14 天为领取截止；超过则未领取不再发放 */
const CLAIM_DEADLINE_DAYS = 14
function isPastClaimDeadline(period: string): boolean {
  const parts = period.split('_')
  if (parts.length !== 2) return true
  const endYMD = parts[1]
  const endDate = new Date(endYMD + 'T23:59:59Z')
  const deadline = new Date(endDate)
  deadline.setUTCDate(deadline.getUTCDate() + CLAIM_DEADLINE_DAYS)
  return Date.now() > deadline.getTime()
}

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
        输入领奖地址后点击「查询」，仅展示最近两周（两个 UTC 自然周）的未领取与已领取记录；超过两周的周期不显示。周期结束超过两周的未领取不再发放，仅展示已领取。领取需连接钱包且为查询地址本人。
      </p>
      <p className="hint" style={{ marginTop: '0.25rem', marginBottom: '0.5rem' }}>
        <a href={contributorRewardExplorerUrl} target="_blank" rel="noopener noreferrer">在区块浏览器查看 ContributorReward 合约</a>
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
          <p className="hint" style={{ marginBottom: '0.5rem' }}>最近两周</p>
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
                <span className="label">TKA 未领取</span>
                <span className="value">{r.claimableT0}</span>
                {isPastClaimDeadline(r.period) && Number(r.claimableT0) > 0 && (
                  <span className="hint" style={{ marginLeft: '0.5rem' }}>已过领取期限，不再发放</span>
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
                <span className="label">TKB 未领取</span>
                <span className="value">{r.claimableT1}</span>
                {isPastClaimDeadline(r.period) && Number(r.claimableT1) > 0 && (
                  <span className="hint" style={{ marginLeft: '0.5rem' }}>已过领取期限，不再发放</span>
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
