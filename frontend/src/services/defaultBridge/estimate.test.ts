import { describe, it, expect } from 'vitest'
import { buildOrderDeliveryEstimate } from './estimate'
import { confirmDisclosure, factorySettings } from './settings'
import type { DefaultBridgeSettings } from './types'

const SEPOLIA = 11155111
const BASE_SEPOLIA = 84532

function settings(patch: Partial<DefaultBridgeSettings> = {}): DefaultBridgeSettings {
  let s = factorySettings()
  s = { ...s, defaultChannel: 'layerzero', homeChainId: BASE_SEPOLIA, standingAuth: true }
  s = confirmDisclosure(s, 'layerzero')
  return { ...s, ...patch }
}

describe('成交前一行预计（§4.1：非阻断、不弹窗）', () => {
  it('默认路径 → 一行预计：含通道名、主场链、收款方承担、测试网实测时效', () => {
    const e = buildOrderDeliveryEstimate({ settings: settings(), settleChainId: SEPOLIA, receivedAsset: 'TKA' })
    expect(e.kind).toBe('line')
    if (e.kind === 'line') {
      expect(e.text).toContain('LayerZero')
      expect(e.text).toContain('Base Sepolia')
      expect(e.text).toContain('由你从成交款承担')
      expect(e.text).toContain('约 8 分钟') // 测试网口径，不许混主网数字
    }
  })

  it('同链 / 未设置 / 不可交付资产 → 无预计行', () => {
    expect(buildOrderDeliveryEstimate({ settings: factorySettings(), settleChainId: SEPOLIA, receivedAsset: 'TKA' }).kind).toBe('none')
    expect(
      buildOrderDeliveryEstimate({ settings: settings({ homeChainId: SEPOLIA }), settleChainId: SEPOLIA, receivedAsset: 'TKA' }).kind
    ).toBe('none')
    expect(buildOrderDeliveryEstimate({ settings: settings(), settleChainId: SEPOLIA, receivedAsset: 'USDT' }).kind).toBe('none')
  })

  it('披露失效 → suspended 行（提示去设置页重新确认）', () => {
    const stale = settings()
    stale.confirmations = []
    const e = buildOrderDeliveryEstimate({ settings: stale, settleChainId: SEPOLIA, receivedAsset: 'TKA' })
    expect(e.kind).toBe('suspended')
    if (e.kind === 'suspended') expect(e.text).toContain('重新确认')
  })
})
