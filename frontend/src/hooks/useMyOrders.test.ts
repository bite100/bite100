/**
 * useMyOrders 单元测试：mock OrderStorage.getUserOrders + 事件触发 refresh
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useMyOrders } from './useMyOrders'
import type { StoredOrder } from '../p2p/storage'

vi.mock('../p2p/storage', () => ({
  OrderStorage: {
    getUserOrders: vi.fn(),
  },
}))

// 通过导入拿到 mock 实例
// eslint-disable-next-line import/first
import { OrderStorage } from '../p2p/storage'

function makeOrder(overrides: Partial<StoredOrder> = {}): StoredOrder {
  return {
    orderId: 'oid-1',
    trader: '0x1234567890123456789012345678901234567890',
    pair: 'TKA/TKB',
    side: 'buy',
    price: '1.5',
    amount: '100',
    timestamp: 0,
    signature: '0x',
    status: 'pending',
    filledAmount: '0',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as StoredOrder
}

const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
  React.createElement(React.Fragment, null, children)

describe('useMyOrders', () => {
  it('returns empty orders and does not call storage when trader is null', async () => {
    const getUserOrdersMock = OrderStorage.getUserOrders as unknown as ReturnType<typeof vi.fn>

    const { result } = renderHook(() => useMyOrders(null), { wrapper })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.orders).toEqual([])
    expect(getUserOrdersMock).not.toHaveBeenCalled()
  })

  it('loads orders for given trader via OrderStorage', async () => {
    const getUserOrdersMock = OrderStorage.getUserOrders as unknown as ReturnType<typeof vi.fn>
    const trader = '0xabc0000000000000000000000000000000000000'
    const orders: StoredOrder[] = [makeOrder({ trader, orderId: 'oid-2' })]
    getUserOrdersMock.mockResolvedValueOnce(orders)

    const { result } = renderHook(() => useMyOrders(trader), { wrapper })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.orders).toEqual(orders)
    expect(getUserOrdersMock).toHaveBeenCalledTimes(1)
    expect(getUserOrdersMock).toHaveBeenCalledWith(trader)
  })
})

