import { describe, it, expect } from 'vitest'
import { normalizeTrade, aggregateTradesToOHLC, type TradeRecord } from './useTradesOHLC'

const E18 = '000000000000000000'

describe('normalizeTrade（节点定点/wei → 人类单位）', () => {
  it('BTC/USDT 真实成交样本换算', () => {
    const t = normalizeTrade({
      tradeId: 'x-1',
      pair: 'BTC/USDT',
      price: `7569605${'0'.repeat(16)}.000000000000000000`,
      amount: `1${'0'.repeat(16)}.000000000000000000`,
      timestamp: 1794073792,
    })
    expect(t.price).toBeCloseTo(75696.05, 6)
    expect(t.amount).toBeCloseTo(0.01, 10)
    expect(t.timestamp).toBe(1794073792)
  })
  it('TKA/TKB 价格 1e18 → 1', () => {
    const t = normalizeTrade({ price: `1${E18}`, amount: `1${E18}`, timestamp: 5 })
    expect(t.price).toBe(1)
    expect(t.amount).toBe(1)
  })
  it('缺字段不崩', () => {
    const t = normalizeTrade(null)
    expect(t.price).toBeNaN()
    expect(t.timestamp).toBe(0)
  })
})

describe('aggregateTradesToOHLC（含成交量）', () => {
  const rec = (price: number, amount: number, timestamp: number): TradeRecord => ({
    price,
    amount,
    timestamp,
  })
  it('同 bar 聚合 OHLC 与量', () => {
    const bars = aggregateTradesToOHLC(
      [rec(100, 1, 3610), rec(110, 2, 3620), rec(90, 3, 3630), rec(105, 4, 3640)],
      3600
    )
    expect(bars).toHaveLength(1)
    expect(bars[0]).toMatchObject({ time: 3600, open: 100, high: 110, low: 90, close: 105, volume: 10 })
  })
  it('跨 bar 分开、乱序输入按时间排序', () => {
    const bars = aggregateTradesToOHLC([rec(5, 1, 7300), rec(3, 1, 100)], 3600)
    expect(bars.map((b) => b.time)).toEqual([0, 7200])
    expect(bars[0].close).toBe(3)
    expect(bars[1].close).toBe(5)
  })
  it('无效价格被过滤', () => {
    const bars = aggregateTradesToOHLC([rec(NaN, 1, 100), rec(0, 1, 200), rec(7, 1, 300)], 3600)
    expect(bars).toHaveLength(1)
    expect(bars[0].close).toBe(7)
  })
  it('空输入空输出', () => {
    expect(aggregateTradesToOHLC([], 3600)).toEqual([])
  })
})
