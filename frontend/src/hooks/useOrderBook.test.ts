/**
 * useOrderBook 单元测试：监听 orderbook-update 自定义事件
 */
import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useOrderBook } from './useOrderBook'
import type { Order } from '../p2p/types'

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    orderId: 'oid-1',
    trader: '0x1234567890123456789012345678901234567890',
    pair: 'TKA/TKB',
    side: 'buy',
    price: '1.5',
    amount: '100',
    timestamp: 0,
    signature: '0x',
    ...overrides,
  }
}

describe('useOrderBook', () => {
  afterEach(() => {
    // 无全局状态需要清理
  })

  it('returns initial empty bids/asks for pair', () => {
    const { result } = renderHook(() => useOrderBook('TKA/TKB'))
    expect(result.current.pair).toBe('TKA/TKB')
    expect(result.current.bids).toEqual([])
    expect(result.current.asks).toEqual([])
  })

  it('updates when orderbook-update event matches pair', async () => {
    const bids: Order[] = [makeOrder({ side: 'buy', price: '1.4' })]
    const asks: Order[] = [makeOrder({ side: 'sell', price: '1.6' })]
    const { result } = renderHook(() => useOrderBook('TKA/TKB'))

    window.dispatchEvent(
      new CustomEvent('orderbook-update', {
        detail: { pair: 'TKA/TKB', bids, asks },
      })
    )

    await waitFor(() => {
      expect(result.current.bids).toEqual(bids)
      expect(result.current.asks).toEqual(asks)
    })
    expect(result.current.pair).toBe('TKA/TKB')
  })

  it('ignores orderbook-update when event pair does not match', () => {
    const bids: Order[] = [makeOrder({ pair: 'OTHER/PAIR' })]
    const asks: Order[] = []
    const { result } = renderHook(() => useOrderBook('TKA/TKB'))

    window.dispatchEvent(
      new CustomEvent('orderbook-update', {
        detail: { pair: 'OTHER/PAIR', bids, asks },
      })
    )

    expect(result.current.pair).toBe('TKA/TKB')
    expect(result.current.bids).toEqual([])
    expect(result.current.asks).toEqual([])
  })
})
