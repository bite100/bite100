/**
 * 下单路径双发集成测试（第三十轮）：
 * 节点主发成功 + 中继副发失败 → 下单仍成功；副发开关关 → 不发副发请求。
 * nodeClient / orderSigning / config 以 mock 代替，relayDualSend 用真实实现。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ethers } from 'ethers'

const relayCfg = vi.hoisted(() => ({ url: 'http://relay.test', enabled: true }))
const nodePostMock = vi.hoisted(() => vi.fn())

vi.mock('../config/relay', () => ({
  get RELAY_URL() {
    return relayCfg.url
  },
  get RELAY_DUAL_SEND_ENABLED() {
    return relayCfg.enabled
  },
}))
vi.mock('../config', () => ({ CHAIN_ID: 11155111 }))
vi.mock('../nodeClient', () => ({ nodePost: nodePostMock }))
vi.mock('./orderSigning', () => ({
  signOrder: vi.fn(async () => '0x' + 'ab'.repeat(65)),
  signCancelOrder: vi.fn(async () => '0x' + 'cd'.repeat(65)),
  generateOrderId: () => 'ord-test-1',
  fetchOrderNonce: vi.fn(async () => 0),
}))

import { submitOrder } from './orderService'

const signer = {
  getAddress: async () => '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
} as unknown as ethers.Signer

const PARAMS = {
  tokenIn: '0x8EDa0025C245B10eA1E10c257674B794C85350f3',
  tokenOut: '0x6Ca8cb68Ee5BB15474f1cfFE07B895C974Ab9c6e',
  amountIn: '1',
  amountOut: '60000',
  price: '60000',
  side: 'buy' as const,
  type: 'limit' as const,
  pair: 'BTC/USDT',
}

describe('submitOrder 双发', () => {
  beforeEach(() => {
    relayCfg.url = 'http://relay.test'
    relayCfg.enabled = true
    nodePostMock.mockReset()
    nodePostMock.mockResolvedValue({ data: { ok: true }, baseUrl: 'http://node1' })
    globalThis.fetch = vi.fn()
    vi.spyOn(console, 'debug').mockImplementation(() => {})
  })

  it('主发成功 + 副发网络失败 → 下单仍成功', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('relay down'))
    await expect(submitOrder(PARAMS, signer)).resolves.toBe('ord-test-1')
    expect(nodePostMock).toHaveBeenCalledTimes(1)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1) // 副发确实尝试过
  })

  it('主发成功 + 副发成功 → 下单成功，副发体含同一 orderId 与 chainId', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true })
    await expect(submitOrder(PARAMS, signer)).resolves.toBe('ord-test-1')
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('http://relay.test/orders')
    expect(JSON.parse(init.body)).toMatchObject({ orderId: 'ord-test-1', chainId: 11155111 })
  })

  it('副发开关关 → 不副发，下单仍成功', async () => {
    relayCfg.enabled = false
    await expect(submitOrder(PARAMS, signer)).resolves.toBe('ord-test-1')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('主发失败 → 下单失败且不副发（副发只在主发成功后）', async () => {
    nodePostMock.mockRejectedValue(new Error('node down'))
    await expect(submitOrder(PARAMS, signer)).rejects.toThrow('node down')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
