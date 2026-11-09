/**
 * useCurrentPair 单元测试（第二十五轮）：
 * - 初始交易对取自 URL ?pair=，非法/缺失时回默认 BTC/USDT；
 * - setPair 切换状态并把 ?pair= 写回 URL。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { useCurrentPair } from './useCurrentPair'

function setUrl(url: string) {
  window.history.replaceState(null, '', url)
}

describe('useCurrentPair', () => {
  beforeEach(() => {
    setUrl('/')
  })

  it('URL 无 ?pair= 时默认 BTC/USDT', () => {
    const { result } = renderHook(() => useCurrentPair())
    expect(result.current.pair).toBe('BTC/USDT')
  })

  it('URL ?pair= 合法时取该对', () => {
    setUrl('/?pair=SOL/USDT')
    const { result } = renderHook(() => useCurrentPair())
    expect(result.current.pair).toBe('SOL/USDT')
  })

  it('URL ?pair= 非法时回默认对', () => {
    setUrl('/?pair=ETH/USD')
    const { result } = renderHook(() => useCurrentPair())
    expect(result.current.pair).toBe('BTC/USDT')
  })

  it('setPair 切换状态并把 ?pair= 写回 URL', () => {
    const { result } = renderHook(() => useCurrentPair())
    act(() => {
      result.current.setPair('LINK/USDT')
    })
    expect(result.current.pair).toBe('LINK/USDT')
    expect(new URL(window.location.href).searchParams.get('pair')).toBe('LINK/USDT')
  })
})

describe('useCurrentPair（第六十轮：自助上架地址型键）', () => {
  beforeEach(() => {
    setUrl('/')
  })

  const LISTED =
    '11155111:0x1111111111111111111111111111111111111111/0x2222222222222222222222222222222222222222'

  it('URL ?pair= 为当前链地址型键时取该对', () => {
    setUrl(`/?pair=${encodeURIComponent(LISTED)}`)
    const { result } = renderHook(() => useCurrentPair())
    expect(result.current.pair).toBe(LISTED)
  })

  it('URL ?pair= 为别链地址型键时回默认对', () => {
    setUrl(`/?pair=${encodeURIComponent(LISTED.replace('11155111', '84532'))}`)
    const { result } = renderHook(() => useCurrentPair())
    expect(result.current.pair).toBe('BTC/USDT')
  })

  it('setPair 可切换到地址型键并写回 URL', () => {
    const { result } = renderHook(() => useCurrentPair())
    act(() => {
      result.current.setPair(LISTED)
    })
    expect(result.current.pair).toBe(LISTED)
    expect(new URL(window.location.href).searchParams.get('pair')).toBe(LISTED)
  })

  it('setPair 拒绝非法值（保持原对）', () => {
    const { result } = renderHook(() => useCurrentPair())
    act(() => {
      result.current.setPair('ETH/USD')
    })
    expect(result.current.pair).toBe('BTC/USDT')
  })
})
