import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  formatScore,
  getLastTwoPeriods,
  periodToId,
  isPastClaimDeadline,
} from './contributorRewardUtils'

describe('formatScore', () => {
  it('returns "0" for null/undefined/empty', () => {
    expect(formatScore(undefined)).toBe('0')
    expect(formatScore(null as unknown as undefined)).toBe('0')
    expect(formatScore('')).toBe('0')
  })
  it('formats 1e18 as 1.000000', () => {
    expect(formatScore(1_000_000_000_000_000_000n)).toBe('1.000000')
    expect(formatScore('1000000000000000000')).toBe('1.000000')
  })
  it('formats 0.5e18 as 0.500000', () => {
    expect(formatScore(500_000_000_000_000_000n)).toBe('0.500000')
  })
  it('rounds to 6 decimals', () => {
    expect(formatScore(1_234_567_890_123_456_789n)).toBe('1.234568')
  })
})

describe('getLastTwoPeriods', () => {
  it('returns [current, previous] with format YYYY-MM-DD_YYYY-MM-DD', () => {
    const periods = getLastTwoPeriods()
    expect(periods).toHaveLength(2)
    expect(periods[0]).toMatch(/^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/)
    expect(periods[1]).toMatch(/^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/)
  })
  it('current week ends after previous week', () => {
    const [current, previous] = getLastTwoPeriods()
    const [, currentEnd] = current.split('_')
    const [, prevEnd] = previous.split('_')
    expect(new Date(currentEnd) > new Date(prevEnd)).toBe(true)
  })
  it('period is Mon_Mon+6 format (7 days)', () => {
    const [current] = getLastTwoPeriods()
    const [start, end] = current.split('_')
    const startDate = new Date(start)
    const endDate = new Date(end)
    const diffDays = Math.round((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000))
    expect(diffDays).toBe(6)
  })
})

describe('periodToId', () => {
  it('returns keccak256 hash of period string', () => {
    const period = '2025-02-03_2025-02-09'
    const id = periodToId(period)
    expect(id).toMatch(/^0x[a-f0-9]{64}$/i)
  })
  it('same input produces same output', () => {
    const period = '2025-02-03_2025-02-09'
    expect(periodToId(period)).toBe(periodToId(period))
  })
  it('different input produces different output', () => {
    expect(periodToId('2025-02-03_2025-02-09')).not.toBe(periodToId('2025-02-10_2025-02-16'))
  })
})

describe('isPastClaimDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns true for invalid period format', () => {
    expect(isPastClaimDeadline('invalid')).toBe(true)
    expect(isPastClaimDeadline('2025-02-03')).toBe(true)
    expect(isPastClaimDeadline('a_b_c')).toBe(true)
  })
  it('returns false when within 14 days of period end', () => {
    // 2025-02-09 为周日，设为周期结束日；当前设为 2025-02-10（周期结束后 1 天）
    vi.setSystemTime(new Date('2025-02-10T12:00:00Z'))
    expect(isPastClaimDeadline('2025-02-03_2025-02-09')).toBe(false)
  })
  it('returns true when more than 14 days past period end', () => {
    // 2025-02-09 周期结束，14 天后为 2025-02-24 00:00 之后
    vi.setSystemTime(new Date('2025-02-25T12:00:00Z'))
    expect(isPastClaimDeadline('2025-02-03_2025-02-09')).toBe(true)
  })
})
