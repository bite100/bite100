/**
 * 市价单计算纯函数测试（第十七轮）：保护价推导与逐档预估成交
 */
import { describe, it, expect } from 'vitest'
import { bestOppositePrice, protectionPrice, estimateMarketFill } from './marketOrder'

const asks = [
  { price: '2.1', amount: '50' },
  { price: '2.0', amount: '50' },
]
const bids = [
  { price: '1.9', amount: '40' },
  { price: '1.95', amount: '10' },
]

describe('bestOppositePrice', () => {
  it('买单取卖盘最低价，卖单取买盘最高价', () => {
    expect(bestOppositePrice('buy', bids, asks)).toBe(2.0)
    expect(bestOppositePrice('sell', bids, asks)).toBe(1.95)
  })
  it('空盘口返回 null', () => {
    expect(bestOppositePrice('buy', bids, [])).toBeNull()
    expect(bestOppositePrice('sell', [], asks)).toBeNull()
  })
})

describe('protectionPrice', () => {
  it('买入向上加滑点、卖出向下减滑点', () => {
    expect(protectionPrice('buy', 2.0, 1)).toBeCloseTo(2.02)
    expect(protectionPrice('sell', 1.95, 1)).toBeCloseTo(1.9305)
  })
  it('滑点钳制在 [0, 50]', () => {
    expect(protectionPrice('buy', 2.0, 0)).toBe(2.0)
    expect(protectionPrice('buy', 2.0, 100)).toBeCloseTo(3.0)
    expect(protectionPrice('sell', 2.0, -5)).toBe(2.0)
  })
})

describe('estimateMarketFill', () => {
  it('逐档成交：两档按最优价顺序吃，均价正确', () => {
    const est = estimateMarketFill('buy', 80, asks, 2.2)
    expect(est.filledQty).toBe(80)
    expect(est.fullyFilled).toBe(true)
    expect(est.avgPrice).toBeCloseTo((50 * 2.0 + 30 * 2.1) / 80)
    expect(est.cappedByProtection).toBe(false)
  })
  it('深度不足：部分成交且未全额', () => {
    const est = estimateMarketFill('buy', 200, asks, 2.2)
    expect(est.filledQty).toBe(100)
    expect(est.fullyFilled).toBe(false)
    expect(est.cappedByProtection).toBe(false)
  })
  it('保护价止步：越过保护价的档位吃不到', () => {
    const est = estimateMarketFill('buy', 80, asks, 2.05)
    expect(est.filledQty).toBe(50)
    expect(est.fullyFilled).toBe(false)
    expect(est.cappedByProtection).toBe(true)
  })
  it('卖向对称：吃买盘最高档起', () => {
    const est = estimateMarketFill('sell', 45, bids, 1.9)
    expect(est.filledQty).toBe(45)
    expect(est.avgPrice).toBeCloseTo((10 * 1.95 + 35 * 1.9) / 45)
    expect(est.fullyFilled).toBe(true)
  })
  it('空盘口：零成交', () => {
    const est = estimateMarketFill('buy', 10, [], 2.2)
    expect(est.filledQty).toBe(0)
    expect(est.avgPrice).toBeNull()
    expect(est.fullyFilled).toBe(false)
  })
})
