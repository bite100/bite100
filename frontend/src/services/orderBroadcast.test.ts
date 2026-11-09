/**
 * 订单双通道广播竞速语义（第 45 轮 A1/A2；第 46 轮 P2-4 真签名化）：
 * - A1：任一通道先接单即返回，挂死通道不得拖住下单返回；双通道都
 *   挂死时在广播期限处按失败返回；落败通道的迟到结果只留
 *   console.debug 痕迹。中继通道 fetch 带显式超时（relayDualSend）。
 * - A2：双通道收到的是同一份签名订单原文（逐字节一致 → 同一
 *   EIP-712 digest），下游去重只认一个订单身份的依据在此钉住。
 * - P2-4（第 46 轮）：订单原文的签名不再用 0xab 假字节——用仓库既有
 *   测试钱包（Hardhat #0，与 dualread.test.ts 同一夹具）经生产
 *   signOrder 真实签名，并以生产 verifyOrderSignatureSignedData
 *   验签断言两通道收到的都是这张真单。
 * nodeClient / config/relay 以 mock 代替，relayDualSend、digest
 * 重算、签名与验签全部走真实实现。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ethers } from 'ethers'
import { buildSignedOrderData, computeOrderDigest } from './dualread/digest'
import { signOrder } from './orderSigning'
import { verifyOrderSignatureSignedData } from './orderVerification'
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

import {
  broadcastOrderDualChannel,
  BROADCAST_CHANNEL_DEADLINE_MS,
} from './orderService'

const CHAIN_ID = 11155111

/** 仓库既有测试钱包（Hardhat 账户 #0，与 dualread.test.ts 同一夹具） */
const TEST_WALLET = new ethers.Wallet(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)

/** 与线上订单票同形状的订单原文（RawOrder 形状，wei 整数字符串） */
const ORDER_BASE = {
  orderId: 'ord-r45-a2',
  trader: TEST_WALLET.address,
  pair: 'BTC/USDT',
  side: 'buy',
  price: '2000000000000000000000',
  amount: '1000000000000000000',
  filled: '0',
  status: 'open',
  createdAt: 1762000000,
  expiresAt: 1762604800,
  nonce: 7,
}

/** 经生产 signOrder 真实签名的订单原文（每个用例前重建） */
let ORDER_BODY: Record<string, unknown>
async function makeSignedOrderBody(): Promise<Record<string, unknown>> {
  const data = buildSignedOrderData(
    { ...ORDER_BASE, signature: '' } as unknown as RawOrder,
    CHAIN_ID,
  )
  if (!data) throw new Error('unbuildable test order')
  const signature = await signOrder(data, TEST_WALLET, CHAIN_ID)
  return { ...ORDER_BASE, signature }
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
  beforeEach(async () => {
    relayCfg.url = 'http://relay.test'
    relayCfg.enabled = true
    nodePostMock.mockReset()
    fetchMock.mockReset()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    ORDER_BODY = await makeSignedOrderBody()
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
    // P2-4：两通道收到的签名都是测试钱包经生产路径签出的真签名，
    // 且经生产验签路径验证通过（checkExpiry 关：夹具时间戳固定，
    // 本条只验签名本身不验时效）
    const data = buildSignedOrderData(nodeBody as unknown as RawOrder, CHAIN_ID)!
    expect(
      await verifyOrderSignatureSignedData(data, nodeBody.signature as string, {
        chainId: CHAIN_ID,
        checkExpiry: false,
      }),
    ).toBe(true)
    expect(relayOrderOnly.signature).toBe(nodeBody.signature)
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
    // 第 46 轮 P2-3：期限到点时节点结果未落定 → nodeUnknown 在场，
    // 调用方须按「待确认」呈现而非断言未接单
    expect(outcome.nodeUnknown).toBe(true)
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
    // 第 46 轮 P2-3：双通道都已落定为失败 → 不是 UNKNOWN，不得标待确认
    expect(outcome.nodeUnknown).toBeUndefined()
  })
})
