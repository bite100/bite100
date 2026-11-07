import { describe, it, expect } from 'vitest'
import { aggregateLevels, depthChartData, depthSeries, powerBarPct, stepOptionsFor } from './depthAggregate'

describe('stepOptionsFor', () => {
  it('scales steps with price magnitude', () => {
    const steps = stepOptionsFor(97842.5)
    expect(steps[0]).toBe(50)
    expect(steps).toContain(500)
    expect(stepOptionsFor(0.5)).toContain(0.01)
    expect(stepOptionsFor(null).length).toBeGreaterThan(0)
  })
})

describe('aggregateLevels', () => {
  const asks = [
    { price: 100.1, amount: 1 },
    { price: 100.4, amount: 2 },
    { price: 101.2, amount: 3 },
  ]
  const bids = [
    { price: 99.9, amount: 1 },
    { price: 99.6, amount: 2 },
    { price: 98.8, amount: 3 },
  ]
  it('groups asks by ceil and bids by floor to the step', () => {
    const a = aggregateLevels(asks, 0.5, 'sell')
    expect(a.map((l) => l.price)).toEqual([100.5, 101.5])
    expect(a[0].amount).toBe(3)
    expect(a[0].total).toBe(3)
    expect(a[1].total).toBe(6)
    const b = aggregateLevels(bids, 0.5, 'buy')
    expect(b.map((l) => l.price)).toEqual([99.5, 98.5])
    expect(b[0].amount).toBe(3)
  })
  it('step 0 keeps raw levels and drops invalid rows', () => {
    const out = aggregateLevels([{ price: 1, amount: 1 }, { price: 0, amount: 5 }, { price: 2, amount: 0 }], 0, 'buy')
    expect(out).toEqual([{ price: 1, amount: 1, total: 1 }])
  })
})

describe('powerBarPct', () => {
  it('splits by cumulative totals and hides when one side is empty', () => {
    const bids = [{ price: 1, amount: 3, total: 3 }]
    const asks = [{ price: 2, amount: 1, total: 1 }]
    expect(powerBarPct(bids, asks)).toEqual({ buyPct: 75, sellPct: 25 })
    expect(powerBarPct([], asks)).toBeNull()
    expect(powerBarPct(bids, [])).toBeNull()
  })
})

describe('depthSeries', () => {
  it('returns null for an empty book (no fake curve)', () => {
    expect(depthSeries([], [], 100)).toBeNull()
  })
  it('accumulates from best prices outward and computes mid/spread', () => {
    const s = depthSeries(
      [
        { price: 99, amount: 1 },
        { price: 98, amount: 2 },
      ],
      [
        { price: 101, amount: 4 },
        { price: 102, amount: 1 },
      ],
      100,
    )
    expect(s).not.toBeNull()
    expect(s!.mid).toBe(100)
    expect(s!.spreadPct).toBeCloseTo(2)
    // 买盘输出价格升序，cum 是从最优价（99）向外的累计
    expect(s!.bids).toEqual([
      { price: 98, cum: 3 },
      { price: 99, cum: 1 },
    ])
    expect(s!.asks).toEqual([
      { price: 101, cum: 4 },
      { price: 102, cum: 5 },
    ])
  })
  it('falls back to last price for mid when only one side exists', () => {
    const s = depthSeries([{ price: 99, amount: 1 }], [], 100)
    expect(s!.mid).toBe(100)
    expect(s!.asks).toEqual([])
  })
})

describe('depthChartData', () => {
  it('maps prices to proportional synthetic times and extends flat to mid', () => {
    const s = depthSeries(
      [
        { price: 99, amount: 1 },
        { price: 98, amount: 2 },
      ],
      [
        { price: 101, amount: 4 },
        { price: 102, amount: 1 },
      ],
      100,
    )!
    const { bids, asks } = depthChartData(s)
    // 买盘：价格升序，末点在中间价（100→10000）取全量累计 3
    expect(bids[bids.length - 1]).toEqual({ time: 10000, value: 3 })
    expect(bids[0]).toEqual({ time: 9800, value: 3 })
    // 卖盘：首点在中间价取全量累计 5
    expect(asks[0]).toEqual({ time: 10000, value: 5 })
    expect(asks[asks.length - 1]).toEqual({ time: 10200, value: 5 })
    for (const arr of [bids, asks]) {
      for (let i = 1; i < arr.length; i++) expect(arr[i].time).toBeGreaterThan(arr[i - 1].time)
    }
  })
  it('forces monotonic times when prices are denser than 0.01', () => {
    const s = depthSeries(
      [
        { price: 0.501, amount: 1 },
        { price: 0.502, amount: 1 },
      ],
      [{ price: 0.509, amount: 1 }],
      0.505,
    )!
    const { bids } = depthChartData(s)
    for (let i = 1; i < bids.length; i++) expect(bids[i].time).toBeGreaterThan(bids[i - 1].time)
  })
})
