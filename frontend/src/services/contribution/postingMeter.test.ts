import { describe, it, expect } from 'vitest'
import {
  meterPostings,
  orderNotionalWei,
  toSegment,
  type PostingLifecycleRecord,
} from './postingMeter'

const MAKER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const MAKER2 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const PERIOD = { periodStart: 1_000, periodEnd: 2_000 }

function rec(patch: Partial<PostingLifecycleRecord>): PostingLifecycleRecord {
  return {
    digest: '0xd1',
    maker: MAKER,
    pair: 'BTC/USDT',
    amountIn: '1000000000000000000', // 1e18
    price: '2000000000000000000000', // 2000e18 → 名义额 2000e18
    createdAt: 1_000,
    expiresAt: 2_000,
    filledAt: null,
    ...patch,
  }
}

describe('orderNotionalWei', () => {
  it('amountIn × price / 1e18', () => {
    expect(orderNotionalWei('1000000000000000000', '2000000000000000000000')).toBe(
      2000n * 10n ** 18n,
    )
  })
  it('非法/非正输入为 0', () => {
    expect(orderNotionalWei('x', '1')).toBe(0n)
    expect(orderNotionalWei('0', '1')).toBe(0n)
    expect(orderNotionalWei('1', '-5')).toBe(0n)
  })
})

describe('toSegment', () => {
  it('全量成交时刻早于到期 → 以成交时刻关闭', () => {
    const s = toSegment(rec({ filledAt: 1_500 }), PERIOD.periodStart, PERIOD.periodEnd)
    expect(s?.end).toBe(1_500)
    expect(s?.start).toBe(1_000)
  })
  it('周期外/到期早于创建 → null', () => {
    expect(toSegment(rec({ createdAt: 3_000, expiresAt: 4_000 }), 1_000, 2_000)).toBeNull()
    expect(toSegment(rec({ createdAt: 1_500, expiresAt: 1_400 }), 1_000, 2_000)).toBeNull()
  })
  it('跨周期订单只取周期内交叠', () => {
    const s = toSegment(rec({ createdAt: 500, expiresAt: 2_500 }), 1_000, 2_000)
    expect(s?.start).toBe(1_000)
    expect(s?.end).toBe(2_000)
  })
})

describe('meterPostings', () => {
  it('单单：积分 = 名义额 × 时长', () => {
    const out = meterPostings([rec({ filledAt: 1_100 })], PERIOD)
    expect(out).toHaveLength(1)
    expect(out[0].maker).toBe(MAKER)
    expect(out[0].score).toBe((2000n * 10n ** 18n * 100n).toString())
    expect(out[0].seconds).toBe(100)
    expect(out[0].orders).toBe(1)
  })

  it('多单同地址跨对汇总、按积分排序', () => {
    const out = meterPostings(
      [
        rec({ digest: '0xd1', filledAt: 1_100 }),
        rec({ digest: '0xd2', maker: MAKER2, filledAt: 1_500 }),
        rec({ digest: '0xd3', pair: 'ETH/USDT', createdAt: 1_200, filledAt: 1_300 }),
      ],
      PERIOD,
    )
    expect(out.map((o) => o.maker)).toEqual([MAKER2, MAKER])
    const mine = out.find((o) => o.maker === MAKER)!
    expect(mine.orders).toBe(2)
    expect(mine.seconds).toBe(200)
  })

  it('同时在场封顶：先到先计，超额部分不计分', () => {
    const cap = 2000n * 10n ** 18n // 恰等于一单名义额
    const out = meterPostings(
      [
        rec({ digest: '0xd1', createdAt: 1_000, filledAt: 1_200 }),
        rec({ digest: '0xd2', createdAt: 1_100, filledAt: 1_300 }),
      ],
      { ...PERIOD, notionalCapPerPair: cap },
    )
    // d1 全程计分（200 秒）；d2 与 d1 重叠的 100 秒额度为 0，仅 1200–1300 的 100 秒计分
    expect(out).toHaveLength(1)
    expect(out[0].seconds).toBe(300)
    expect(out[0].score).toBe((2000n * 10n ** 18n * 300n).toString())
  })

  it('不同交易对不互相挤占封顶', () => {
    const cap = 2000n * 10n ** 18n
    const out = meterPostings(
      [
        rec({ digest: '0xd1', createdAt: 1_000, filledAt: 1_200 }),
        rec({ digest: '0xd2', pair: 'ETH/USDT', createdAt: 1_000, filledAt: 1_200 }),
      ],
      { ...PERIOD, notionalCapPerPair: cap },
    )
    expect(out[0].seconds).toBe(400)
  })

  it('空输入与全非法输入 → 空结果', () => {
    expect(meterPostings([], PERIOD)).toEqual([])
    expect(meterPostings([rec({ amountIn: '0' })], PERIOD)).toEqual([])
  })
})
