/**
 * 第 35 轮 D8：双读模式徽标渲染测试。
 * 请求 active 但未接线（有效 shadow）→ 必须明示「正式模式尚未接线」，
 * 绝不出现「合并视图展示中」；该文案只留给真正接线后的 active。
 * 另验三态说明段随标注同轮上线（功能变更带说明的常设规则）。
 */
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DirectionTrustNotice, RelayModesExplanation, ShadowModePill, Stage3AdmissionExplanation } from './RelayStatus'

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

describe('DirectionTrustNotice（第 36 轮方向可信过渡说明）', () => {
  it('明示方向无法证明、可成交认证暂停、恢复条件是协议升级', () => {
    const text = html(<DirectionTrustNotice />)
    expect(text).toContain('方向')
    expect(text).toContain('无法被证明')
    expect(text).toContain('不认证任何订单为「可成交」')
    expect(text).toContain('协议')
    expect(text).toContain('纳入签名')
  })

  it('准入说明写明 3A/3B 拆分、双链各自计数与过渡期口径', () => {
    const text = html(<Stage3AdmissionExplanation />)
    expect(text).toContain('3A')
    expect(text).toContain('3B')
    expect(text).toContain('各自累计 ≥500')
    expect(text).toContain('自动满足')
    expect(text).toContain('不能替代 3B')
  })
})
