import { describe, it, expect } from 'vitest'
import {
  channelSupports,
  decideRoute,
  hasValidConfirmation,
  pairSameChainOnly,
  supportedChannelsFor,
} from './support'
import { confirmDisclosure, factorySettings } from './settings'
import type { DefaultBridgeSettings } from './types'

const SEPOLIA = 11155111
const BASE_SEPOLIA = 84532

function readySettings(patch: Partial<DefaultBridgeSettings> = {}): DefaultBridgeSettings {
  let s = factorySettings()
  s = { ...s, defaultChannel: 'layerzero', homeChainId: BASE_SEPOLIA, standingAuth: true }
  s = confirmDisclosure(s, 'layerzero')
  return { ...s, ...patch }
}

describe('支持矩阵（§6：桥 × 链对 × 资产，静态算出）', () => {
  it('TKA 在 Sepolia ↔ Base Sepolia 三桥全支持', () => {
    for (const ch of ['layerzero', 'ccip', 'wormhole'] as const) {
      expect(channelSupports(ch, SEPOLIA, BASE_SEPOLIA, 'TKA')).toBe(true)
      expect(channelSupports(ch, BASE_SEPOLIA, SEPOLIA, 'TKA')).toBe(true)
    }
    expect(supportedChannelsFor(SEPOLIA, BASE_SEPOLIA, 'TKA')).toHaveLength(3)
  })

  it('非 TKA 资产没有任何桥支持（不许假装支持）', () => {
    for (const asset of ['USDT', 'BTC', 'ETH', 'TKB', 'DOGE']) {
      expect(supportedChannelsFor(SEPOLIA, BASE_SEPOLIA, asset)).toHaveLength(0)
      expect(channelSupports('layerzero', SEPOLIA, BASE_SEPOLIA, asset)).toBe(false)
    }
  })

  it('同链不支持、未部署桥配置的主网链对不支持', () => {
    expect(channelSupports('layerzero', SEPOLIA, SEPOLIA, 'TKA')).toBe(false)
    expect(channelSupports('ccip', SEPOLIA, 1, 'TKA')).toBe(false)
  })

  it('交易对「仅同链交易」标注：两侧都不可交付才标', () => {
    expect(pairSameChainOnly('BTC/USDT')).toBe(true)
    expect(pairSameChainOnly('ETH/USDT')).toBe(true)
    expect(pairSameChainOnly('TKA/TKB')).toBe(false)
  })
})

describe('路由判定（§1.2 + §6 一级/三级）', () => {
  it('未设置 → none(unset)；同链 → none(same-chain)；授权关 → none(auth-off)', () => {
    expect(decideRoute(factorySettings(), SEPOLIA, 'TKA')).toEqual({ kind: 'none', reason: 'unset' })
    expect(decideRoute(readySettings({ homeChainId: SEPOLIA }), SEPOLIA, 'TKA')).toEqual({
      kind: 'none',
      reason: 'same-chain',
    })
    expect(decideRoute(readySettings({ standingAuth: false }), SEPOLIA, 'TKA')).toEqual({
      kind: 'none',
      reason: 'auth-off',
    })
  })

  it('默认桥支持 → 一级默认路径', () => {
    expect(decideRoute(readySettings(), SEPOLIA, 'TKA')).toEqual({ kind: 'default', channel: 'layerzero' })
  })

  it('披露确认失效（旧版本）→ 挂起，不自动交付', () => {
    const s = readySettings()
    s.confirmations = [{ channel: 'layerzero', disclosureVersion: 999, confirmedAt: Date.now() }]
    expect(decideRoute(s, SEPOLIA, 'TKA')).toEqual({ kind: 'suspended-disclosure', channel: 'layerzero' })
    expect(hasValidConfirmation(s, 'layerzero')).toBe(false)
  })

  it('默认桥不支持（资产不可交付）→ none(asset-unsupported)，不打断问用户', () => {
    expect(decideRoute(readySettings(), SEPOLIA, 'USDT')).toEqual({ kind: 'none', reason: 'asset-unsupported' })
  })

  it('无备选预设 settle-chain-only → none(settle-chain-only-pref)', () => {
    // 构造默认桥不支持但资产可交付的情形：把默认通道设为 wormhole 且链对改为不支持的方向不可行
    // （三桥同链对同资产支持度一致），故直接验证预设分支：home 链改到无桥配置的主网链 1
    const s = readySettings({ homeChainId: 1, noFallbackPref: 'settle-chain-only' })
    expect(decideRoute(s, SEPOLIA, 'TKA')).toEqual({ kind: 'none', reason: 'settle-chain-only-pref' })
  })

  it('默认 ask → 三级询问，带可用通道清单', () => {
    const s = readySettings({ homeChainId: 1 })
    const d = decideRoute(s, SEPOLIA, 'TKA')
    expect(d.kind).toBe('ask')
    if (d.kind === 'ask') expect(d.supportedChannels).toEqual([])
  })
})
