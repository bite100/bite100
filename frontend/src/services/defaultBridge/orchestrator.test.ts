import { describe, it, expect, beforeEach } from 'vitest'
import {
  computeReceipts,
  executeDelivery,
  fillFromLocalTrade,
  planDelivery,
  revalidatePendingDisclosures,
  symbolForToken,
} from './orchestrator'
import { confirmDisclosure, factorySettings } from './settings'
import { getDelivery } from './deliveries'
import { withSigner } from '../../utils'
import type { SettledFillInput } from './orchestrator'
import type { DefaultBridgeSettings } from './types'

/** 可计数的 withSigner 桩：被调用即计数并抛指定错误（不触碰真实钱包）。 */
function throwingSigner(error: Error) {
  let calls = 0
  const fn = (async () => {
    calls++
    throw error
  }) as unknown as typeof withSigner
  return { fn, calls: () => calls }
}

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

describe('第 63 轮桥-1：披露执行复验（P1-②）', () => {
  beforeEach(() => localStorage.clear())

  it('升版前的 pending 记录执行时被复验拦下：转挂起、抛错、零执行尝试', async () => {
    const out = planDelivery(TAKER, fill(), settings())
    expect(out.record?.status).toBe('pending-decision')
    // 模拟升版：当前版本已不是确认时记下的版本
    const stale = settings()
    stale.confirmations = [{ channel: 'layerzero', disclosureVersion: 1, confirmedAt: 0 }]
    const stub = throwingSigner(new Error('不应被调用'))
    await expect(executeDelivery(TAKER, out.record!.id, stale, { withSignerFn: stub.fn })).rejects.toThrow(
      '披露已更新，请重新确认后继续'
    )
    expect(stub.calls()).toBe(0)
    expect(getDelivery(TAKER, 'trade-x', TAKER)?.status).toBe('suspended-disclosure')
  })

  it('确认仍有效时复验放行（执行进入发起阶段）', async () => {
    const out = planDelivery(TAKER, fill(), settings())
    const stub = throwingSigner(new Error('halt-at-signer'))
    // executeDelivery 内部吞错落异常记录：放行后签名器被调用且错误进入异常注记
    const result = await executeDelivery(TAKER, out.record!.id, settings(), { withSignerFn: stub.fn })
    expect(stub.calls()).toBe(1)
    expect(result.status).toBe('anomaly')
    expect(result.anomalyKind).toBe('initiation-failed')
    expect(result.anomalyNote).toContain('halt-at-signer')
  })

  it('加载批量复验：只挂起失效通道的 pending 记录，其余不动', () => {
    planDelivery(TAKER, fill(), settings())
    const ccipSettings = confirmDisclosure(settings({ defaultChannel: 'ccip' }), 'ccip')
    const ccipOut = planDelivery(TAKER, fill({ tradeId: 'trade-ccip' }), ccipSettings)
    expect(ccipOut.record?.status).toBe('pending-decision')
    expect(ccipOut.record?.channel).toBe('ccip')
    // 复验时只给 LZ 的有效确认 → CCIP 记录应挂起，LZ 记录不动
    const onlyLz = settings()
    const records = revalidatePendingDisclosures(TAKER, onlyLz, 99)
    expect(records.find((r) => r.tradeId === 'trade-x')?.status).toBe('pending-decision')
    expect(records.find((r) => r.tradeId === 'trade-ccip')?.status).toBe('suspended-disclosure')
    expect(getDelivery(TAKER, 'trade-ccip', TAKER)?.status).toBe('suspended-disclosure')
  })
})
