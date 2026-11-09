/**
 * 下单广播测试：第 30–48 轮为「节点主通道 + 中继副通道」双通道竞速
 * （broadcastOrderDualChannel 的双腿落定/期限/迟到留痕语义已随节点
 * 退役删除，逐条登记见第 51 轮文档）；第 51 轮起中继单通道
 * （broadcastOrder）口径：
 * - 中继明确接单（2xx）→ viaRelay；请求体 = 订单原文 + chainId，
 *   且原文里的签名经生产验签路径可验（原 A2/P2-4 真签名断言的
 *   单源形态：中继收到的就是这张真单，下游按 digest 只认一单）；
 * - 中继明确拒单（非 2xx）→ relayError 带中继返回的原因，不是 UNKNOWN；
 * - 传输层失败（超时/网络错误）→ relayUnknown（结果未定，不得断言
 *   未接单，第 46 轮 P2-3 口径在单源下保留）；
 * - 发单请求带 AbortSignal 超时（15 秒），永不无界等待；
 * - 中继未配置 → 不发请求、relayError 明示未配置。
 * config 以 mock 代替，签名/验签/digest 重算全部走真实实现。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ethers } from 'ethers'
import { buildSignedOrderData, computeOrderDigest } from './dualread/digest'
import { signOrder } from './orderSigning'
import { verifyOrderSignatureSignedData } from './orderVerification'
import type { RawOrder } from './dualread/types'

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

import {
  broadcastOrder,
  BROADCAST_UNKNOWN_MESSAGE,
  RELAY_POST_TIMEOUT_MS,
} from './orderService'

const CHAIN_ID = 11155111

/** 仓库既有测试钱包（Hardhat 账户 #0，与 dualread.test.ts 同一夹具） */
const TEST_WALLET = new ethers.Wallet(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)

const BODY = { orderId: 'ord-1', pair: 'BTC/USDT', side: 'buy' }

describe('broadcastOrder（第 51 轮中继单通道）', () => {
  beforeEach(() => {
    relayCfg.url = 'http://relay.test'
    globalThis.fetch = vi.fn()
  })

  it('中继接单（200）→ viaRelay=true，请求体含 orderId 与 chainId', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200 })
    const outcome = await broadcastOrder(BODY, CHAIN_ID)
    expect(outcome.viaRelay).toBe(true)
    expect(outcome.relayUnknown).toBeUndefined()
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('http://relay.test/orders')
    expect(JSON.parse(init.body)).toMatchObject({ orderId: 'ord-1', chainId: CHAIN_ID })
  })

  it('真签名断言（原 A2/P2-4 单源形态）：中继收到的订单原文签名可验、digest 与本地重算一致', async () => {
    // 与旧双通道 A2 同一夹具口径：先由订单原文经生产 buildSignedOrderData
    // 重构出签名数据、再经生产 signOrder 真签名，自洽性由构造保证。
    const ORDER_BASE = {
      orderId: 'ord-r51-a2',
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
    const data = buildSignedOrderData(
      { ...ORDER_BASE, signature: '' } as unknown as RawOrder,
      CHAIN_ID,
    )
    expect(data).not.toBeNull()
    const signature = await signOrder(data!, TEST_WALLET, CHAIN_ID)
    const orderBody = { ...ORDER_BASE, signature }
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200 })
    const outcome = await broadcastOrder(orderBody, CHAIN_ID)
    expect(outcome.viaRelay).toBe(true)
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const sent = JSON.parse(init.body) as Record<string, unknown>
    // 中继收到的原文重构回签名订单：验签通过且 digest 与签名时一致
    const rebuilt = buildSignedOrderData(sent as unknown as RawOrder, CHAIN_ID)
    expect(rebuilt).not.toBeNull()
    expect(computeOrderDigest(rebuilt!, CHAIN_ID)).toBe(computeOrderDigest(data!, CHAIN_ID))
    await expect(
      verifyOrderSignatureSignedData(rebuilt!, String(sent.signature), {
        chainId: CHAIN_ID,
        checkExpiry: false,
      }),
    ).resolves.toBe(true)
  })

  it('发单请求带 AbortSignal（显式超时纪律，永不无界等待）', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200 })
    await broadcastOrder(BODY, CHAIN_ID)
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(RELAY_POST_TIMEOUT_MS).toBe(15_000)
  })

  it('中继明确拒单（400 + error 原因）→ relayError 带原因、不是 UNKNOWN', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid signature' }),
    })
    const outcome = await broadcastOrder(BODY, CHAIN_ID)
    expect(outcome.viaRelay).toBe(false)
    expect(outcome.relayUnknown).toBeUndefined()
    expect(outcome.relayError).toBeInstanceOf(Error)
    expect((outcome.relayError as Error).message).toContain('中继拒单（HTTP 400）')
    expect((outcome.relayError as Error).message).toContain('invalid signature')
  })

  it('中继拒单且响应体不可解析 → relayError 只带状态码', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json')
      },
    })
    const outcome = await broadcastOrder(BODY, CHAIN_ID)
    expect(outcome.viaRelay).toBe(false)
    expect((outcome.relayError as Error).message).toContain('HTTP 502')
  })

  it('网络失败（fetch reject）→ relayUnknown=true（结果未定）', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('relay down'))
    const outcome = await broadcastOrder(BODY, CHAIN_ID)
    expect(outcome.viaRelay).toBe(false)
    expect(outcome.relayUnknown).toBe(true)
    expect(outcome.relayError).toBeInstanceOf(Error)
  })

  it('超时（TimeoutError）→ relayUnknown=true', async () => {
    const timeoutErr = new Error('timed out')
    timeoutErr.name = 'TimeoutError'
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(timeoutErr)
    const outcome = await broadcastOrder(BODY, CHAIN_ID)
    expect(outcome.relayUnknown).toBe(true)
  })

  it('中继未配置（RELAY_URL 为空）→ relayError 明示未配置，且不发请求', async () => {
    relayCfg.url = ''
    const outcome = await broadcastOrder(BODY, CHAIN_ID)
    expect(outcome.viaRelay).toBe(false)
    expect(outcome.relayUnknown).toBeUndefined()
    expect((outcome.relayError as Error).message).toContain('未配置')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('UNKNOWN 文案为中继口径：提示待确认与勿重复下单', () => {
    expect(BROADCAST_UNKNOWN_MESSAGE).toContain('订单结果待确认')
    expect(BROADCAST_UNKNOWN_MESSAGE).toContain('中继通道超时')
    expect(BROADCAST_UNKNOWN_MESSAGE).toContain('请勿立即重复下单')
    expect(BROADCAST_UNKNOWN_MESSAGE).not.toContain('节点')
  })
})
