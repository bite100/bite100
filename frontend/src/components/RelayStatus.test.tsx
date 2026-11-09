/**
 * 第 51 轮改写：原测试钉的是第 35/36 轮的双读影子组件
 * （ShadowModePill / RelayModesExplanation / DirectionTrustNotice /
 * Stage3AdmissionExplanation）——这些组件随节点退役与影子区一并删除，
 * 原断言（「正式模式尚未接线」等）已无对应物。新断言改为单源时代的
 * 状态区事实：三项健康如实呈现（测试环境未配置端点 → 未部署/未知）、
 * 节点退役说明在场、且不得再出现双读/节点口径的旧文案。
 * 改写登记见 docs/round51-stage5-node-retirement-2026-11-09.md。
 */
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RelayStatus } from './RelayStatus'

const html = (): string => renderToStaticMarkup(<RelayStatus />)

describe('RelayStatus（第 51 轮单源状态区）', () => {
  it('三项健康齐备：主中继 / Nostr 镜像 / 链上索引', () => {
    const text = html()
    expect(text).toContain('主中继（Workers + D1）')
    expect(text).toContain('Nostr 镜像')
    expect(text).toContain('链上索引（Envio）')
  })

  it('未配置端点时如实显示未部署，不假绿', () => {
    const text = html()
    expect(text).toContain('未部署')
    expect(text).toContain('下单与订单簿都经主中继')
  })

  it('节点退役说明在场：撤单统一走链上撤单', () => {
    const text = html()
    expect(text).toContain('节点退役（无节点阶段 5）')
    expect(text).toContain('链上撤单')
    expect(text).toContain('中继簿不提供撤单接口')
  })

  it('不得再出现双读/节点口径的旧文案', () => {
    const text = html()
    expect(text).not.toContain('双读影子对比')
    expect(text).not.toContain('节点单读')
    expect(text).not.toContain('待索引')
    expect(text).not.toContain('下单仍走节点通道')
    expect(text).not.toContain('下单仍可走节点通道')
  })
})
