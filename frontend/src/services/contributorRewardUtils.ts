/**
 * 贡献奖励周期与领取截止（与合约、ContributionSection、UnifiedRewardClaim 共用）
 */
import { solidityPackedKeccak256 } from 'ethers'

/** 贡献分 1e18 精度 → 可读小数 */
export function formatScore(raw: string | bigint | undefined): string {
  if (raw == null || raw === '') return '0'
  try {
    const n = typeof raw === 'string' ? BigInt(raw) : raw
    return (Number(n) / 1e18).toFixed(6)
  } catch {
    return String(raw)
  }
}

/** 最近两周（UTC 自然周）：[本周, 上周] */
export function getLastTwoPeriods(): string[] {
  const toYMD = (d: Date) => d.toISOString().slice(0, 10)
  const now = new Date()
  const utcMon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const day = now.getUTCDay()
  const daysSinceMon = (day + 6) % 7
  utcMon.setUTCDate(utcMon.getUTCDate() - daysSinceMon)
  const currentEnd = new Date(utcMon)
  currentEnd.setUTCDate(currentEnd.getUTCDate() + 6)
  const current = `${toYMD(utcMon)}_${toYMD(currentEnd)}`
  const prevMon = new Date(utcMon)
  prevMon.setUTCDate(prevMon.getUTCDate() - 7)
  const prevEnd = new Date(prevMon)
  prevEnd.setUTCDate(prevEnd.getUTCDate() + 6)
  const previous = `${toYMD(prevMon)}_${toYMD(prevEnd)}`
  return [current, previous]
}

/** 与合约 _periodId 一致：keccak256(abi.encodePacked(period)) */
export function periodToId(period: string): string {
  return solidityPackedKeccak256(['string'], [period])
}

/** 领取期限（方案 A，与合约 CLAIM_DEADLINE_SECONDS 一致）：周期结束后 90 天内可领 */
export const CLAIM_DEADLINE_DAYS = 90

/** 某周期的领取截止时间（UTC）；周期格式非法时返回 null */
export function getClaimDeadline(period: string): Date | null {
  const parts = period.split('_')
  if (parts.length !== 2) return null
  const endDate = new Date(parts[1] + 'T23:59:59Z')
  if (Number.isNaN(endDate.getTime())) return null
  const deadline = new Date(endDate)
  deadline.setUTCDate(deadline.getUTCDate() + CLAIM_DEADLINE_DAYS)
  return deadline
}

/** 是否已过领取截止（与合约一致：now > 周期结束 + 90 天）；逾期未领部分将回流下一期 */
export function isPastClaimDeadline(period: string): boolean {
  const deadline = getClaimDeadline(period)
  if (!deadline) return true
  return Date.now() > deadline.getTime()
}
