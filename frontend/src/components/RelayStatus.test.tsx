/**
 * 第 35 轮 D8：双读模式徽标渲染测试。
 * 请求 active 但未接线（有效 shadow）→ 必须明示「正式模式尚未接线」，
 * 绝不出现「合并视图展示中」；该文案只留给真正接线后的 active。
 * 另验三态说明段随标注同轮上线（功能变更带说明的常设规则）。
 */
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RelayModesExplanation, ShadowModePill } from './RelayStatus'

const html = (el: React.ReactElement): string => renderToStaticMarkup(el)

describe('ShadowModePill', () => {
  it('请求 active、有效 shadow → 明示未接线，不宣称合并视图', () => {
    const text = html(<ShadowModePill requested="active" mode="shadow" />)
    expect(text).toContain('正式模式尚未接线')
    expect(text).toContain('当前按影子模式运行')
    expect(text).not.toContain('合并视图展示中')
  })

  it('影子模式 → 「影子模式 · 只观察」', () => {
    const text = html(<ShadowModePill requested="shadow" mode="shadow" />)
    expect(text).toContain('影子模式 · 只观察')
    expect(text).not.toContain('合并视图展示中')
  })

  it('真正接线后的 active（请求与有效一致）→ 才许「合并视图展示中」', () => {
    const text = html(<ShadowModePill requested="active" mode="active" />)
    expect(text).toContain('合并视图展示中')
  })
})

describe('RelayModesExplanation（三态说明）', () => {
  it('三种模式各有说明，且明示正式模式尚未接线', () => {
    const text = html(<RelayModesExplanation />)
    expect(text).toContain('disabled')
    expect(text).toContain('shadow')
    expect(text).toContain('active')
    expect(text).toContain('尚未接线')
  })
})
