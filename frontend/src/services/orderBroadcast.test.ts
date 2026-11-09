/**
 * 订单双通道广播竞速语义（第 45 轮 A1/A2）：
 * - A1：任一通道先接单即返回，挂死通道不得拖住下单返回；双通道都
 *   挂死时在广播期限处按失败返回；落败通道的迟到结果只留
 *   console.debug 痕迹。中继通道 fetch 带显式超时（relayDualSend）。
 * - A2：双通道收到的是同一份签名订单原文（逐字节一致 → 同一
 *   EIP-712 digest），下游去重只认一个订单身份的依据在此钉住。
 * nodeClient / config/relay 以 mock 代替，relayDualSend 与 digest
 * 重算走真实实现（与 dualread.test.ts 同口径）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildSignedOrderData, computeOrderDigest } from './dualread/digest'
import type { RawOrder } from './dualread/types'

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
vi.mock('../nodeClient', () => ({ nodePost: nodePostMock }))
vi.mock('./orderSigning', () => ({
  signOrder: vi.fn(async () => '0x' + 'ab'.repeat(65)),
  signCancelOrder: vi.fn(async () => '0x' + 'cd'.repeat(65)),
  generateOrderId: () => 'ord-test-1',
  fetchOrderNonce: vi.fn(async () => 0),
}))

import {
  broadcastOrderDualChannel,
  BROADCAST_CHANNEL_DEADLINE_MS,
} from './orderService'

const CHAIN_ID = 11155111

/** 与线上订单票同形状的签名订单原文（RawOrder 形状，wei 整数字符串） */
const ORDER_BODY: Record<string, unknown> = {
  orderId: 'ord-r45-a2',
  trader: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  pair: 'BTC/USDT',
  side: 'buy',
  price: '2000000000000000000000',
  amount: '1000000000000000000',
  filled: '0',
  status: 'open',
  createdAt: 1762000000,
  expiresAt: 1762604800,
  nonce: 7,
  signature: '0x' + 'ab'.repeat(65),
}

const fetchMock = vi.fn()
let debugSpy: ReturnType<typeof vi.spyOn>

function digestOf(body: Record<string, unknown>): string {
  const data = buildSignedOrderData(body as unknown as RawOrder, CHAIN_ID)
  expect(data).not.toBeNull()
  return computeOrderDigest(data!, CHAIN_ID)
}

/** 1 秒内不返回即判挂死回归（真计时下的人工上限，远小于通道期限） */
async function withinOneSecond<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('广播未在 1s 内返回（挂死回归）')), 1000),
    ),
  ])
}

describe('broadcastOrderDualChannel（第 45 轮 A1/A2）', () => {
  beforeEach(() => {
    relayCfg.url = 'http://relay.test'
    relayCfg.enabled = true
    nodePostMock.mockReset()
    fetchMock.mockReset()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('A2：双通道都接单 → 两侧标志为真；两通道收到的订单原文逐字节一致、同 digest', async () => {
    nodePostMock.mockResolvedValue({ data: { ok: true }, baseUrl: 'http://node1' })
    fetchMock.mockResolvedValue({ ok: true })
    const outcome = await broadcastOrderDualChannel(ORDER_BODY, CHAIN_ID)
    expect(outcome).toEqual({ viaNode: true, viaRelay: true })

    // 节点通道收到的就是传入的订单原文
    const nodeBody = nodePostMock.mock.calls[0][1] as Record<string, unknown>
    expect(nodeBody).toBe(ORDER_BODY)
    // 中继通道收到的是同一原文 + chainId：去掉 chainId 后逐字节一致
    const [relayUrl, relayInit] = fetchMock.mock.calls[0]
    expect(relayUrl).toBe('http://relay.test/orders')
    const relayBody = JSON.parse(relayInit.body as string) as Record<string, unknown>
    expect(relayBody.chainId).toBe(CHAIN_ID)
    const { chainId: _drop, ...relayOrderOnly } = relayBody
    expect(JSON.stringify(relayOrderOnly)).toBe(JSON.stringify(nodeBody))
    // 同一原文 → 同一 EIP-712 digest：下游（中继按 digest、节点按
    // orderId）去重只认一个订单身份的依据
    expect(digestOf(relayOrderOnly)).toBe(digestOf(nodeBody))
  })

  it('A1：节点挂死 + 中继接单 → 不等节点，立即按中继成功返回', async () => {
    nodePostMock.mockImplementation(() => new Promise(() => {}))
    fetchMock.mockResolvedValue({ ok: true })
    const outcome = await withinOneSecond(broadcastOrderDualChannel(ORDER_BODY, CHAIN_ID))
    expect(outcome.viaRelay).toBe(true)
    expect(outcome.viaNode).toBe(false)
  })

  it('A1：中继挂死 + 节点接单 → 不等中继，立即按节点成功返回', async () => {
    nodePostMock.mockResolvedValue({ data: { ok: true }, baseUrl: 'http://node1' })
    fetchMock.mockImplementation(() => new Promise(() => {}))
    const outcome = await withinOneSecond(broadcastOrderDualChannel(ORDER_BODY, CHAIN_ID))
    expect(outcome.viaNode).toBe(true)
    expect(outcome.viaRelay).toBe(false)
  })

  it('A1：双通道都挂死 → 广播期限处按失败返回，nodeError 为超时错误', async () => {
    vi.useFakeTimers()
    nodePostMock.mockImplementation(() => new Promise(() => {}))
    fetchMock.mockImplementation(() => new Promise(() => {}))
    const p = broadcastOrderDualChannel(ORDER_BODY, CHAIN_ID)
    await vi.advanceTimersByTimeAsync(BROADCAST_CHANNEL_DEADLINE_MS + 1)
    const outcome = await p
    expect(outcome.viaNode).toBe(false)
    expect(outcome.viaRelay).toBe(false)
    expect(outcome.nodeError).toBeInstanceOf(Error)
    expect((outcome.nodeError as Error).message).toContain('超时')
  })

  it('A1：落败通道迟到接单 → 广播结果不变，迟到结果留 console 痕迹', async () => {
    let lateResolve: ((v: unknown) => void) | undefined
    nodePostMock.mockImplementation(
      () => new Promise((res) => { lateResolve = res }),
    )
    fetchMock.mockResolvedValue({ ok: true })
    const outcome = await withinOneSecond(broadcastOrderDualChannel(ORDER_BODY, CHAIN_ID))
    expect(outcome.viaRelay).toBe(true)
    lateResolve!({ data: { ok: true }, baseUrl: 'http://node1' })
    await new Promise((r) => setTimeout(r, 10))
    const traces = debugSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((s: string) => s.includes('[broadcast]'))
    expect(traces.some((s: string) => s.includes('迟到接单'))).toBe(true)
  })

  it('双通道都失败 → 返回失败结果，nodeError 带节点侧原始错误', async () => {
    nodePostMock.mockRejectedValue(new Error('node down'))
    fetchMock.mockRejectedValue(new Error('relay down'))
    const outcome = await broadcastOrderDualChannel(ORDER_BODY, CHAIN_ID)
    expect(outcome.viaNode).toBe(false)
    expect(outcome.viaRelay).toBe(false)
    expect(outcome.nodeError).toBeInstanceOf(Error)
    expect((outcome.nodeError as Error).message).toBe('node down')
  })
})
