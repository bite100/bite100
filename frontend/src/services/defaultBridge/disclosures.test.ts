import { describe, it, expect } from 'vitest'
import { CHANNEL_DISCLOSURES, etaShortTextFor, etaTextFor, currentDisclosureVersion } from './disclosures'
import type { DefaultChannelId } from './types'

const CHANNELS: DefaultChannelId[] = ['layerzero', 'ccip', 'wormhole']

describe('逐通道披露（§2.3 六要素，缺一不可）', () => {
  it('每条通道六要素齐全且失败文案三段式齐全', () => {
    for (const ch of CHANNELS) {
      const d = CHANNEL_DISCLOSURES[ch]
      expect(d.feeStructure.length).toBeGreaterThan(10)
      expect(d.etaMainnetText.length).toBeGreaterThan(5)
      expect(d.etaTestnetText.length).toBeGreaterThan(5)
      expect(d.securityModel.length).toBeGreaterThan(10)
      expect(d.riskPoints.length).toBeGreaterThanOrEqual(2)
      expect(d.irreversibility).toContain('不可取消')
      expect(d.failureDestination).toContain('Vault')
      expect(d.failureGuide.initiationFailure).toContain('Vault')
      expect(d.failureGuide.inTransitTimeout.length).toBeGreaterThan(10)
      expect(d.failureGuide.destinationIssue).toContain('Vault')
      expect(d.version).toBe(currentDisclosureVersion(ch))
    }
  })

  it('LayerZero 披露含 1-of-1 DVN 的大白话与概率性确认说明', () => {
    const d = CHANNEL_DISCLOSURES.layerzero
    const all = [d.securityModel, ...d.riskPoints].join('\n')
    expect(all).toContain('目前只有 LayerZero 官方一家在验证，等于信任这一家')
    expect(all).toContain('概率性确认')
  })

  it('CCIP 写明 DON+RMN，Wormhole 写明 13-of-19', () => {
    expect(CHANNEL_DISCLOSURES.ccip.securityModel).toContain('RMN')
    expect(CHANNEL_DISCLOSURES.wormhole.securityModel).toContain('13')
    expect(CHANNEL_DISCLOSURES.wormhole.securityModel).toContain('19')
  })

  it('时效主网/测试网分开写，不混写（§3）', () => {
    for (const ch of CHANNELS) {
      expect(etaTextFor(ch, 11155111)).toBe(CHANNEL_DISCLOSURES[ch].etaTestnetText)
      expect(etaTextFor(ch, 1)).toBe(CHANNEL_DISCLOSURES[ch].etaMainnetText)
      expect(CHANNEL_DISCLOSURES[ch].etaTestnetText).toContain('测试网')
    }
    // 主网短时效：LZ 是「几分钟」，CCIP/Wormhole 是「十几分钟」量级
    expect(etaShortTextFor('layerzero', 1)).toContain('2–6 分钟')
    expect(etaShortTextFor('ccip', 1)).toContain('15–20 分钟')
    expect(etaShortTextFor('wormhole', 1)).toContain('15 分钟')
    // 测试网短时效用实测口径
    expect(etaShortTextFor('wormhole', 84532)).toContain('59 分钟')
  })

  it('费率文案只写结构不写死实时数字（LZ 的 0.1 TKA 固定桥费除外，那是合约口径）', () => {
    // CCIP / Wormhole 的费用数字必须实时读取，文案中不得出现具体 ETH 数字
    expect(CHANNEL_DISCLOSURES.ccip.feeStructure).not.toMatch(/\d+(\.\d+)?\s*ETH/)
    expect(CHANNEL_DISCLOSURES.wormhole.feeStructure).not.toMatch(/\d+(\.\d+)?\s*ETH/)
    for (const ch of CHANNELS) {
      expect(CHANNEL_DISCLOSURES[ch].feeStructure).toContain('收款方')
    }
  })
})
