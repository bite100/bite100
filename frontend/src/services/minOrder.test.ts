/**
 * 最低交易额 $1 校验单元测试（第六十轮）：
 * - 锚优先级：美元参考价 > 稳定币计价按本单价 > 计价币面值；
 * - 恰好 $1 通过、低于拦截；数量/价格非法 → 不通过；
 * - 非美元参考价（本所成交价）不作美元锚（TKA/TKB 走面值口径）。
 */
import { describe, it, expect } from 'vitest'
import { evaluateMinOrder, minOrderErrorMessage } from './minOrder'

describe('evaluateMinOrder', () => {
  it('有美元参考价：按参考价估算（与本单价无关）', () => {
    const r = evaluateMinOrder({
      amount: 0.001,
      orderPrice: 100,
      quoteSymbol: 'USDT',
      refPrice: 2000,
      refUsdDenominated: true,
    })
    expect(r.basis).toBe('referenceUsd')
    expect(r.usdValue).toBeCloseTo(2)
    expect(r.pass).toBe(true)
  })

  it('有美元参考价但金额不足 $1 → 拦截', () => {
    const r = evaluateMinOrder({
      amount: 0.0001,
      orderPrice: 2000,
      quoteSymbol: 'USDT',
      refPrice: 2000,
      refUsdDenominated: true,
    })
    expect(r.pass).toBe(false)
    expect(r.usdValue).toBeCloseTo(0.2)
  })

  it('无参考价 + 稳定币计价：按本单价估算；恰好 $1 通过', () => {
    const r = evaluateMinOrder({
      amount: 0.5,
      orderPrice: 2,
      quoteSymbol: 'USDT',
      refPrice: null,
      refUsdDenominated: false,
    })
    expect(r.basis).toBe('stableQuote')
    expect(r.usdValue).toBeCloseTo(1)
    expect(r.pass).toBe(true)
  })

  it('非美元参考价（本所成交）不作锚：TKA/TKB 走计价币面值', () => {
    const r = evaluateMinOrder({
      amount: 10,
      orderPrice: 0.05,
      quoteSymbol: 'TKB',
      refPrice: 0.05,
      refUsdDenominated: false,
    })
    expect(r.basis).toBe('quoteFace')
    expect(r.usdValue).toBeNull()
    expect(r.pass).toBe(false) // 面值 0.5 < 1
  })

  it('计价币面值口径：面值达到 1 通过', () => {
    const r = evaluateMinOrder({
      amount: 100,
      orderPrice: 0.02,
      quoteSymbol: 'TKB',
      refPrice: null,
      refUsdDenominated: false,
    })
    expect(r.basis).toBe('quoteFace')
    expect(r.pass).toBe(true)
  })

  it('USDC/DAI 同样算美元稳定币计价', () => {
    for (const quoteSymbol of ['USDC', 'DAI', 'usdt']) {
      const r = evaluateMinOrder({
        amount: 2,
        orderPrice: 0.4,
        quoteSymbol,
        refPrice: null,
        refUsdDenominated: false,
      })
      expect(r.basis).toBe('stableQuote')
      expect(r.pass).toBe(false) // 0.8 < 1
    }
  })

  it('数量/价格非法 → 不通过（basis none）', () => {
    expect(
      evaluateMinOrder({ amount: 0, orderPrice: 1, quoteSymbol: 'USDT', refPrice: null, refUsdDenominated: false }),
    ).toEqual({ pass: false, usdValue: null, basis: 'none' })
    expect(
      evaluateMinOrder({ amount: NaN, orderPrice: 1, quoteSymbol: 'USDT', refPrice: null, refUsdDenominated: false })
        .pass,
    ).toBe(false)
  })

  it('报错文案：面值口径不编造美元数', () => {
    const face = evaluateMinOrder({
      amount: 1,
      orderPrice: 0.5,
      quoteSymbol: 'TKB',
      refPrice: null,
      refUsdDenominated: false,
    })
    expect(minOrderErrorMessage(face)).toContain('暂无美元参考价')
    const usd = evaluateMinOrder({
      amount: 0.1,
      orderPrice: 1,
      quoteSymbol: 'USDT',
      refPrice: null,
      refUsdDenominated: false,
    })
    expect(minOrderErrorMessage(usd)).toContain('$0.10')
  })
})
