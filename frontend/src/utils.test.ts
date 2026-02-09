import { describe, it, expect, beforeEach } from 'vitest'
import {
  formatTokenAmount,
  shortAddress,
  isValidAddress,
  formatError,
  cacheGet,
  cacheSet,
  cacheInvalidate,
  CACHE_KEYS,
  getEthereum,
} from './utils'

describe('formatTokenAmount', () => {
  it('returns "0" for null/undefined', () => {
    expect(formatTokenAmount(undefined)).toBe('0')
    expect(formatTokenAmount(null as unknown as undefined)).toBe('0')
  })
  it('formats 1e18 as 1.000000', () => {
    expect(formatTokenAmount(1_000_000_000_000_000_000n)).toBe('1.000000')
  })
  it('formats 0.5e18 as 0.500000', () => {
    expect(formatTokenAmount(500_000_000_000_000_000n)).toBe('0.500000')
  })
  it('rounds to 6 decimals', () => {
    expect(formatTokenAmount(1_234_567_890_123_456_789n)).toBe('1.234568')
  })
})

describe('shortAddress', () => {
  it('returns full address when too short', () => {
    expect(shortAddress('0x1234')).toBe('0x1234')
  })
  it('returns shortened 0x42-char address', () => {
    const addr = '0x1234567890123456789012345678901234567890'
    expect(shortAddress(addr)).toBe('0x1234...7890')
  })
  it('respects start/end params', () => {
    const addr = '0x1234567890123456789012345678901234567890'
    // start=8 表示前 8 个字符（含 0x），end=6 表示后 6 个字符
    expect(shortAddress(addr, 8, 6)).toBe('0x123456...567890')
  })
})

describe('isValidAddress', () => {
  it('returns true for valid 0x40 hex', () => {
    expect(isValidAddress('0x1234567890123456789012345678901234567890')).toBe(true)
  })
  it('returns false for non-0x', () => {
    expect(isValidAddress('1234567890123456789012345678901234567890')).toBe(false)
  })
  it('returns false for wrong length', () => {
    expect(isValidAddress('0x1234')).toBe(false)
    expect(isValidAddress('0x' + 'a'.repeat(41))).toBe(false)
  })
  it('trims whitespace', () => {
    expect(isValidAddress('  0x1234567890123456789012345678901234567890  ')).toBe(true)
  })
  it('returns false for empty', () => {
    expect(isValidAddress('')).toBe(false)
    expect(isValidAddress('   ')).toBe(false)
  })
})

describe('getEthereum', () => {
  it('falls back to window.phantom.ethereum when window.ethereum is missing', () => {
    const w = window as any
    // 清理可能存在的 ethereum 注入
    delete w.ethereum
    w.phantom = { ethereum: { foo: 'bar' } }

    const provider = getEthereum()
    expect(provider).toBe(w.phantom.ethereum)
  })
})

describe('formatError', () => {
  it('returns 操作失败 for null/undefined', () => {
    expect(formatError(null)).toBe('操作失败')
    expect(formatError(undefined)).toBe('操作失败')
  })
  it('returns 您已拒绝签名 for 4001 / user rejected', () => {
    expect(formatError({ code: 4001 })).toBe('您已拒绝签名或切换网络')
    expect(formatError({ message: 'User rejected' })).toBe('您已拒绝签名或切换网络')
    expect(formatError({ reason: 'denied' })).toBe('您已拒绝签名或切换网络')
  })
  it('returns 网络相关 for fetch/network errors', () => {
    expect(formatError({ message: 'fetch failed' })).toContain('网络异常')
    expect(formatError({ message: 'Failed to fetch' })).toContain('网络异常')
    expect(formatError({ message: 'network error' })).toContain('网络')
  })
  it('returns 网络错误 for chain', () => {
    expect(formatError({ message: 'wrong chain' })).toContain('网络错误')
  })
  it('returns Governance messages', () => {
    expect(formatError({ message: 'Governance: not in active set' })).toBe('当前地址不在活跃集内，无法投票')
    expect(formatError({ message: 'Governance: already voted' })).toBe('您已投过票')
    expect(formatError({ message: 'Governance: voting ended' })).toBe('投票已结束')
    expect(formatError({ message: 'Governance: not passed' })).toBe('赞成票未超过半数，无法执行')
  })
  it('returns 余额不足 / 授权额度不足 for CALL_EXCEPTION', () => {
    expect(formatError({ message: 'CALL_EXCEPTION insufficient balance' })).toBe('余额不足')
    expect(formatError({ message: 'CALL_EXCEPTION insufficient allowance' })).toBe('授权额度不足，请先 Approve')
  })
  it('truncates long raw message to 80 chars', () => {
    const long = 'x'.repeat(100)
    expect(formatError({ message: long }).length).toBeLessThanOrEqual(81)
    expect(formatError({ message: long })).toMatch(/\.\.\.$/)
  })
})

describe('cache', () => {
  beforeEach(() => {
    cacheInvalidate('') // clear all
  })

  it('returns null for missing key', () => {
    expect(cacheGet('none')).toBe(null)
  })
  it('returns value after set within TTL', () => {
    cacheSet('k1', { a: 1 }, 60000)
    expect(cacheGet<{ a: number }>('k1')).toEqual({ a: 1 })
  })
  it('invalidates by prefix', () => {
    cacheSet(CACHE_KEYS.BALANCE + 'a', 1, 60000)
    cacheSet(CACHE_KEYS.BALANCE + 'b', 2, 60000)
    cacheSet('other', 3, 60000)
    cacheInvalidate(CACHE_KEYS.BALANCE)
    expect(cacheGet(CACHE_KEYS.BALANCE + 'a')).toBe(null)
    expect(cacheGet(CACHE_KEYS.BALANCE + 'b')).toBe(null)
    expect(cacheGet('other')).toBe(3)
  })
})
