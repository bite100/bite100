/**
 * 下单路径集成测试：第 30 轮–阶段 4 为双通道广播（节点+中继任一接单
 * 即成功、副发开关等用例已随节点退役删除，登记见第 51 轮文档）；
 * 第 51 轮起 submitOrder 只经中继单通道（broadcastOrder 真实实现）：
 * - 中继接单 → 返回 orderId，请求体含 orderId 与 chainId；
 * - 中继明确拒单 → 抛中继原因；
 * - 传输层失败（结果未定）→ 抛待确认文案（不得断言未接单）；
 * - 中继未配置 → 抛未配置错误，且不发请求。
 * config / orderSigning 以 mock 代替，fetch 以 mock 代替。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ethers } from 'ethers'

const relayCfg = vi.hoisted(() => ({ url: 'http://relay.test' }))

vi.mock('../config/relay', () => ({
  get RELAY_URL() {
    return relayCfg.url
  },
  get RELAY_CONFIGURED() {
    return relayCfg.url !== ''
  },
}))
vi.mock('../config', () => ({ CHAIN_ID: 11155111 }))
vi.mock('./orderSigning', () => ({
  signOrder: vi.fn(async () => '0x' + 'ab'.repeat(65)),
  generateOrderId: () => 'ord-test-1',
  fetchOrderNonce: vi.fn(async () => 0),
}))

import { submitOrder, BROADCAST_UNKNOWN_MESSAGE } from './orderService'

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

describe('submitOrder 中继单通道广播', () => {
  beforeEach(() => {
    relayCfg.url = 'http://relay.test'
    globalThis.fetch = vi.fn()
  })

  it('中继接单 → 下单成功，请求体含同一 orderId 与 chainId', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200 })
    await expect(submitOrder(PARAMS, signer)).resolves.toBe('ord-test-1')
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('http://relay.test/orders')
    expect(JSON.parse(init.body)).toMatchObject({ orderId: 'ord-test-1', chainId: 11155111 })
  })

  it('中继明确拒单 → 抛中继拒单原因', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'insufficient available balance' }),
    })
    await expect(submitOrder(PARAMS, signer)).rejects.toThrow('中继拒单（HTTP 400）')
    await expect(submitOrder(PARAMS, signer)).rejects.toThrow('insufficient available balance')
  })

  it('中继网络失败（结果未定）→ 抛待确认文案，不说未接单', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('relay down'))
    await expect(submitOrder(PARAMS, signer)).rejects.toThrow(BROADCAST_UNKNOWN_MESSAGE)
  })

  it('中继未配置 → 抛未配置错误且不发请求', async () => {
    relayCfg.url = ''
    await expect(submitOrder(PARAMS, signer)).rejects.toThrow('未配置')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
