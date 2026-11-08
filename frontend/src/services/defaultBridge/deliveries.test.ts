import { describe, it, expect, beforeEach } from 'vitest'
import { deliveryKey, getDelivery, loadDeliveries, transition, upsertDelivery } from './deliveries'
import type { DeliveryRecord } from './types'

const ACCOUNT = '0xAbC0000000000000000000000000000000000001'

function rec(patch: Partial<DeliveryRecord> = {}): DeliveryRecord {
  return {
    id: deliveryKey('trade-1', ACCOUNT),
    tradeId: 'trade-1',
    receiver: ACCOUNT,
    settleChainId: 11155111,
    homeChainId: 84532,
    pair: 'TKA/TKB',
    asset: 'TKA',
    amountWei: '1000',
    channel: 'layerzero',
    executor: 'bridge',
    status: 'pending-decision',
    fundsLocation: 'vault',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

describe('交付记录存储与幂等（§7.1）', () => {
  beforeEach(() => localStorage.clear())

  it('幂等键 = 成交 ID × 收款方（小写）', () => {
    expect(deliveryKey('T1', ACCOUNT)).toBe(`T1:${ACCOUNT.toLowerCase()}`)
  })

  it('同键 upsert 不产生第二条记录（编排器重扫不重复发起的凭据）', () => {
    const a = upsertDelivery(ACCOUNT, rec())
    expect(a.created).toBe(true)
    const b = upsertDelivery(ACCOUNT, rec({ status: 'in-flight' }))
    expect(b.created).toBe(false)
    expect(loadDeliveries(ACCOUNT)).toHaveLength(1)
    expect(getDelivery(ACCOUNT, 'trade-1', ACCOUNT)?.status).toBe('in-flight')
  })
})

describe('交付状态机（§1.2 / §7.3）', () => {
  it('正路径：pending → initiating → in-flight → delivered', () => {
    let r = rec()
    r = transition(r, { type: 'initiate', at: 2 })
    r = transition(r, { type: 'initiated', at: 3, txHash: '0xtx', trackingId: 'guid', trackingUrl: 'https://x', feeNativeWei: '10' })
    expect(r.status).toBe('in-flight')
    expect(r.feeNativeWei).toBe('10')
    r = transition(r, { type: 'delivered', at: 4 })
    expect(r.status).toBe('delivered')
    expect(r.deliveredAt).toBe(4)
  })

  it('非法迁移抛错（终态不可再动、未发起不可到账）', () => {
    expect(() => transition(rec({ status: 'delivered' }), { type: 'initiate', at: 2 })).toThrow()
    expect(() =>
      transition(rec(), { type: 'initiated', at: 2, txHash: '0x', trackingId: 'g', trackingUrl: 'u', feeNativeWei: '0' })
    ).toThrow()
  })

  it('发起失败 → 异常，可重试回 pending；重试后可再次发起', () => {
    let r = rec()
    r = transition(r, { type: 'initiate', at: 2 })
    r = transition(r, { type: 'initiation-failed', at: 3, note: '用户拒签' })
    expect(r.status).toBe('anomaly')
    expect(r.anomalyKind).toBe('initiation-failed')
    r = transition(r, { type: 'retry', at: 4 })
    expect(r.status).toBe('pending-decision')
    r = transition(r, { type: 'initiate', at: 5 })
    expect(r.status).toBe('initiating')
  })

  it('在途超时 → 异常（超时），且绝不置 fallbackCredited（§7.3 防双记账）', () => {
    let r = rec({ status: 'in-flight', initiatedAt: 1 })
    r = transition(r, { type: 'timeout', at: 9, note: '超时' })
    expect(r.anomalyKind).toBe('timeout')
    expect(r.fallbackCredited).toBeFalsy()
    // 超时记录不许走 retry（消息可能仍在途，重发会双发）
    expect(() => transition(r, { type: 'retry', at: 10 })).toThrow()
  })

  it('通道确认失败 → 异常（channel-failed），第一期前端也不冒充已记回', () => {
    let r = rec({ status: 'in-flight', initiatedAt: 1 })
    r = transition(r, { type: 'channel-failure-confirmed', at: 9, note: '桥状态失败' })
    expect(r.anomalyKind).toBe('channel-failed')
    expect(r.fallbackCredited).toBeFalsy()
    expect(() => transition(r, { type: 'retry', at: 10 })).toThrow()
  })

  it('披露挂起 → 重新确认后回 pending；ask → 选临时通道回 pending / 选只在成交链交付转 not-needed', () => {
    let s = rec({ status: 'suspended-disclosure' })
    s = transition(s, { type: 'reconfirmed', at: 2 })
    expect(s.status).toBe('pending-decision')
    let a = rec({ status: 'ask-required', channel: null })
    a = transition(a, { type: 'choose-temp-channel', at: 2, channel: 'ccip' })
    expect(a.status).toBe('pending-decision')
    expect(a.channel).toBe('ccip')
    let b = rec({ status: 'ask-required', channel: null })
    b = transition(b, { type: 'resolve-settle-chain-only', at: 2 })
    expect(b.status).toBe('not-needed')
  })

  it('executor 字段第一期恒为 bridge（§8 选项 C 预留）', () => {
    expect(rec().executor).toBe('bridge')
  })
})
