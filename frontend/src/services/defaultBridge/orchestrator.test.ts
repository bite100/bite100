import { describe, it, expect, beforeEach } from 'vitest'
import { computeReceipts, fillFromLocalTrade, planDelivery, symbolForToken } from './orchestrator'
import { confirmDisclosure, factorySettings } from './settings'
import type { SettledFillInput } from './orchestrator'
import type { DefaultBridgeSettings } from './types'

const SEPOLIA = 11155111
const BASE_SEPOLIA = 84532
const MAKER = '0xE83D2b08356cb463adFc20406a18B79991F7eE29'
const TAKER = '0x87ffF84eb917916587fA7721c843cdC3Ada957eA'
// Sepolia 链配置里的 TKA / TKB 地址（chains.ts 登记）
const TKA_SEP = '0x93a4af54d7cD8aF7c9aEF50D3Dd3977bA1Dde28E'
const TKB_SEP = '0x1530b74E6d5C2D0e2b78314b5C253E66bfC4ddc2'

function fill(patch: Partial<SettledFillInput> = {}): SettledFillInput {
  return {
    tradeId: 'trade-x',
    settleChainId: SEPOLIA,
    maker: MAKER,
    taker: TAKER,
    tokenIn: TKA_SEP, // maker 卖 TKA
    tokenOut: TKB_SEP, // maker 收 TKB
    amountIn: '1000000000000000000',
    amountOut: '2000000000000000000',
    pair: 'TKA/TKB',
    ...patch,
  }
}

function settings(patch: Partial<DefaultBridgeSettings> = {}): DefaultBridgeSettings {
  let s = factorySettings()
  s = { ...s, defaultChannel: 'layerzero', homeChainId: BASE_SEPOLIA, standingAuth: true }
  s = confirmDisclosure(s, 'layerzero')
  return { ...s, ...patch }
}

describe('收款方向计算（结算记账口径）', () => {
  it('maker 收 tokenOut、taker 收 tokenIn，金额对应', () => {
    const r = computeReceipts(fill())
    expect(r).toEqual([
      { receiver: MAKER, asset: 'TKB', amountWei: 2000000000000000000n },
      { receiver: TAKER, asset: 'TKA', amountWei: 1000000000000000000n },
    ])
  })

  it('符号反查大小写不敏感；未登记代币跳过该侧', () => {
    expect(symbolForToken(SEPOLIA, TKA_SEP.toUpperCase().replace('0X', '0x'))).toBe('TKA')
    const r = computeReceipts(fill({ tokenOut: '0x000000000000000000000000000000000000dEaD' }))
    expect(r).toHaveLength(1)
    expect(r[0].receiver).toBe(TAKER)
  })

  it('本地 Trade 适配：sell 时 maker 付 base 收 quote（数量×价格）', () => {
    const f = fillFromLocalTrade(
      { tradeId: 't1', maker: MAKER, taker: TAKER, pair: 'TKA/TKB', amount: '2000000000000000000', price: '3000000000000000000', makerSide: 'sell' },
      SEPOLIA
    )
    expect(f?.tokenIn).toBe(TKA_SEP)
    expect(f?.amountIn).toBe('2000000000000000000')
    expect(f?.amountOut).toBe('6000000000000000000')
    expect(f?.pair).toBe('TKA/TKB')
  })

  it('本地 Trade 无 makerSide → 不适配（方向不明不凭空编造）', () => {
    expect(
      fillFromLocalTrade({ tradeId: 't1', maker: MAKER, taker: TAKER, pair: 'TKA/TKB', amount: '1', price: '1' }, SEPOLIA)
    ).toBeNull()
  })
})

describe('交付规划（§1.2 判定 + §7.1 幂等）', () => {
  beforeEach(() => localStorage.clear())

  it('未设置默认桥 → 不生成记录、不做任何动作（验收 §10.2）', () => {
    const out = planDelivery(TAKER, fill(), factorySettings())
    expect(out.record).toBeNull()
    expect(out.created).toBe(false)
  })

  it('我是 taker（收 TKA）、默认 LZ、主场在 Base → pending-decision 走 LZ', () => {
    const out = planDelivery(TAKER, fill(), settings())
    expect(out.created).toBe(true)
    expect(out.record?.status).toBe('pending-decision')
    expect(out.record?.channel).toBe('layerzero')
    expect(out.record?.asset).toBe('TKA')
    expect(out.record?.amountWei).toBe('1000000000000000000')
    expect(out.record?.executor).toBe('bridge')
  })

  it('重复规划同笔成交 → 返回已有记录且 created=false（永不重复发起）', () => {
    const a = planDelivery(TAKER, fill(), settings())
    const b = planDelivery(TAKER, fill(), settings())
    expect(a.created).toBe(true)
    expect(b.created).toBe(false)
    expect(b.record?.id).toBe(a.record?.id)
  })

  it('我是 maker（收 TKB，不可交付资产）→ not-needed 记录', () => {
    const out = planDelivery(MAKER, fill(), settings())
    expect(out.record?.status).toBe('not-needed')
  })

  it('同链（主场 = 成交链）→ not-needed', () => {
    const out = planDelivery(TAKER, fill(), settings({ homeChainId: SEPOLIA }))
    expect(out.record?.status).toBe('not-needed')
  })

  it('授权关闭 → not-needed；披露失效 → suspended-disclosure', () => {
    expect(planDelivery(TAKER, fill(), settings({ standingAuth: false })).record?.status).toBe('not-needed')
    const stale = settings()
    stale.confirmations = []
    expect(planDelivery(TAKER, fill({ tradeId: 'trade-stale' }), stale).record?.status).toBe('suspended-disclosure')
  })

  it('成交与我无关 → 无记录', () => {
    const out = planDelivery('0x0000000000000000000000000000000000000001', fill(), settings())
    expect(out.record).toBeNull()
  })
})
