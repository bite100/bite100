/**
 * 第 59 轮块 4：POST /orders 防滥用限流器（固定窗口，isolate 内存）。
 * 只钉限流器本身的语义；入口接线在 index-orders.test.ts。
 */
import { describe, expect, it } from 'vitest'
import { FixedWindowRateLimiter } from '../../src/rateLimit'

describe('FixedWindowRateLimiter', () => {
  it('窗口内放行到上限，之后拒绝；key 之间互不影响', () => {
    const lim = new FixedWindowRateLimiter(60_000)
    const t0 = 1_700_000_000_000
    expect(lim.allow('a', 3, t0)).toBe(true)
    expect(lim.allow('a', 3, t0 + 1)).toBe(true)
    expect(lim.allow('a', 3, t0 + 2)).toBe(true)
    expect(lim.allow('a', 3, t0 + 3)).toBe(false)
    expect(lim.allow('b', 3, t0 + 3)).toBe(true)
  })

  it('窗口滚动后重新放行', () => {
    const lim = new FixedWindowRateLimiter(60_000)
    const t0 = 1_700_000_000_000
    expect(lim.allow('a', 1, t0)).toBe(true)
    expect(lim.allow('a', 1, t0 + 59_999)).toBe(false)
    expect(lim.allow('a', 1, t0 + 60_000)).toBe(true)
  })

  it('reset 清空全部窗口', () => {
    const lim = new FixedWindowRateLimiter(60_000)
    const t0 = 1_700_000_000_000
    expect(lim.allow('a', 1, t0)).toBe(true)
    expect(lim.allow('a', 1, t0)).toBe(false)
    lim.reset()
    expect(lim.allow('a', 1, t0)).toBe(true)
  })
})
