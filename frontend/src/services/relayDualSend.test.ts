/**
 * 订单副发到公告栏中继的单元测试：best-effort 语义——任何失败都不得抛错、
 * 不得影响下单；开关关 / URL 未配置时静默跳过（不发请求）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const relayCfg = vi.hoisted(() => ({ url: 'http://relay.test', enabled: true }))

vi.mock('../config/relay', () => ({
  get RELAY_URL() {
    return relayCfg.url
  },
  get RELAY_DUAL_SEND_ENABLED() {
    return relayCfg.enabled
  },
}))

import { dualSendOrderToRelay } from './relayDualSend'

const ORDER = { orderId: 'ord-1', pair: 'BTC/USDT', side: 'buy' }

describe('dualSendOrderToRelay', () => {
  beforeEach(() => {
    relayCfg.url = 'http://relay.test'
    relayCfg.enabled = true
    globalThis.fetch = vi.fn()
    vi.spyOn(console, 'debug').mockImplementation(() => {})
  })

  it('副发成功返回 true，请求体带 chainId', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true })
    await expect(dualSendOrderToRelay(ORDER, 11155111)).resolves.toBe(true)
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('http://relay.test/orders')
    expect(JSON.parse(init.body)).toMatchObject({ orderId: 'ord-1', chainId: 11155111 })
  })

  it('请求带显式超时信号（第 45 轮 A1：挂死连接按时 abort）', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true })
    await expect(dualSendOrderToRelay(ORDER, 11155111)).resolves.toBe(true)
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('网络失败只吞错返回 false，永不抛错（下单不受影响）', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'))
    await expect(dualSendOrderToRelay(ORDER, 11155111)).resolves.toBe(false)
  })

  it('中继返回非 2xx 返回 false，不抛错', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 401 })
    await expect(dualSendOrderToRelay(ORDER, 11155111)).resolves.toBe(false)
  })

  it('开关关时不副发（不发任何请求）', async () => {
    relayCfg.enabled = false
    await expect(dualSendOrderToRelay(ORDER, 11155111)).resolves.toBe(false)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('中继 URL 未配置时静默跳过', async () => {
    relayCfg.url = ''
    await expect(dualSendOrderToRelay(ORDER, 11155111)).resolves.toBe(false)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
