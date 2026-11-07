import { describe, it, expect } from 'vitest'
import { bridgeCta, expectedArrival, prepState, wrapShortfallWei } from './prepState'

const W = (n: number) => BigInt(n) * 10n ** 18n

describe('prepState', () => {
  it('only ccip/wormhole need wrapping', () => {
    expect(prepState('layerzero', W(10), 0n)).toBe('none')
    expect(prepState('fastlane', W(10), 0n)).toBe('none')
    expect(prepState(null, W(10), 0n)).toBe('none')
  })
  it('walks pending-amount → need-wrap → ready', () => {
    expect(prepState('ccip', 0n, 0n)).toBe('pending-amount')
    expect(prepState('ccip', W(10), W(4))).toBe('need-wrap')
    expect(prepState('wormhole', W(10), W(10))).toBe('ready')
    expect(prepState('wormhole', W(10), W(11))).toBe('ready')
  })
  it('computes the shortfall', () => {
    expect(wrapShortfallWei(W(10), W(4))).toBe(W(6))
    expect(wrapShortfallWei(W(10), W(10))).toBe(0n)
  })
})

describe('bridgeCta', () => {
  const base = {
    prep: 'none' as const,
    account: '0xabc',
    hasSource: true,
    hasTarget: true,
    hasAmount: true,
    loading: false,
  }
  it('no channel → pick-first text, disabled', () => {
    expect(bridgeCta({ ...base, bridge: null })).toEqual({ disabled: true, text: '先选择通道，再发起转移' })
  })
  it('need-wrap → wrap-first text, disabled', () => {
    expect(bridgeCta({ ...base, bridge: 'ccip', prep: 'need-wrap' })).toEqual({
      disabled: true,
      text: '先完成包裹，再发起转移',
    })
  })
  it('ready when fields complete; disabled without amount', () => {
    expect(bridgeCta({ ...base, bridge: 'layerzero' })).toEqual({ disabled: false, text: '发起跨链转移' })
    expect(bridgeCta({ ...base, bridge: 'layerzero', hasAmount: false }).disabled).toBe(true)
  })
})

describe('expectedArrival', () => {
  it('message bridges arrive as WTKA 1:1', () => {
    expect(expectedArrival({ bridge: 'ccip', amountText: '10' })).toBe('10 WTKA')
    expect(expectedArrival({ bridge: 'wormhole', amountText: '' })).toBe('—')
  })
  it('layerzero deducts the 0.1 TKA bridge fee from arrival', () => {
    expect(expectedArrival({ bridge: 'layerzero', amountText: '10' })).toContain('9.9 TKA')
    expect(expectedArrival({ bridge: 'layerzero', amountText: '0.05' })).toContain('0 TKA')
  })
  it('fastlane uses the live quote net or a dash', () => {
    expect(expectedArrival({ bridge: 'fastlane', amountText: '10', fastlaneNet: '9.98 USDC' })).toBe('9.98 USDC')
    expect(expectedArrival({ bridge: 'fastlane', amountText: '10' })).toBe('—')
    expect(expectedArrival({ bridge: null, amountText: '10' })).toBe('—')
  })
})
