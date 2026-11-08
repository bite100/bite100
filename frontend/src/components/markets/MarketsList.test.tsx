/**
 * 第 34 轮：行情行价格格三态渲染测试（追加缺陷修复——无成交行不显示价格）。
 * 无成交+有参考价 → 显参考价并带「参考价」标注；无成交+无参考价 → 暂无成交；
 * 有成交 → 维持现状（主价为成交价、$ 小字为参考价且无「参考价」标注）。
 */
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { MarketPriceCell } from './MarketsList'

describe('MarketPriceCell 三态', () => {
  it('无成交 + 有参考价：价格位显参考价并标注「参考价」，不是成交价', () => {
    const { container } = render(<MarketPriceCell lastPrice={null} refUsd={3000.5} />)
    const text = container.textContent ?? ''
    expect(text).toContain('$3,000.50')
    expect(text).toContain('参考价')
    expect(text).not.toContain('暂无成交')
  })

  it('无成交 + 无参考价：显示「暂无成交」', () => {
    const { container } = render(<MarketPriceCell lastPrice={null} refUsd={null} />)
    const text = container.textContent ?? ''
    expect(text).toContain('暂无成交')
    expect(text).not.toContain('参考价')
  })

  it('有成交：维持现状——主价为成交价、$ 小字为参考价、无「参考价」标注', () => {
    const { container } = render(<MarketPriceCell lastPrice={65000} refUsd={64900.25} />)
    const text = container.textContent ?? ''
    expect(text).toContain('65,000.00')
    expect(text).toContain('$64,900.25')
    expect(text).not.toContain('参考价')
    expect(text).not.toContain('暂无成交')
  })
})
