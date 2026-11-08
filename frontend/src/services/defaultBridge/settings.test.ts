import { describe, it, expect, beforeEach } from 'vitest'
import {
  confirmDisclosure,
  consumeTempOverride,
  factorySettings,
  loadSettings,
  pushTempOverride,
  saveSettings,
} from './settings'
import { currentDisclosureVersion } from './disclosures'

const ACCOUNT = '0xAbC0000000000000000000000000000000000001'

describe('设置存储（§2.1 每用户一份）', () => {
  beforeEach(() => localStorage.clear())

  it('无记录时回出厂设置：未选通道、授权关、无备选预设为 ask（§11 定版）', () => {
    const s = loadSettings(ACCOUNT)
    expect(s).toEqual(factorySettings())
    expect(s.noFallbackPref).toBe('ask')
    expect(s.standingAuth).toBe(false)
  })

  it('存取往返一致，地址大小写不敏感', () => {
    let s = factorySettings()
    s = { ...s, defaultChannel: 'ccip', homeChainId: 84532, standingAuth: true }
    s = confirmDisclosure(s, 'ccip', 123456)
    saveSettings(ACCOUNT, s)
    const back = loadSettings(ACCOUNT.toLowerCase())
    expect(back.defaultChannel).toBe('ccip')
    expect(back.homeChainId).toBe(84532)
    expect(back.confirmations).toEqual([
      { channel: 'ccip', disclosureVersion: currentDisclosureVersion('ccip'), confirmedAt: 123456 },
    ])
  })

  it('脏数据回出厂设置，不抛错', () => {
    localStorage.setItem('bit100.defaultBridge.settings.v1.' + ACCOUNT.toLowerCase(), '{not json')
    expect(loadSettings(ACCOUNT)).toEqual(factorySettings())
  })

  it('确认记录同通道只留最新一条', () => {
    let s = factorySettings()
    s = confirmDisclosure(s, 'wormhole', 1)
    s = confirmDisclosure(s, 'wormhole', 2)
    expect(s.confirmations).toHaveLength(1)
    expect(s.confirmations[0].confirmedAt).toBe(2)
  })

  it('一次性临时授权：按链+资产消费一次即删，不匹配不消费', () => {
    pushTempOverride(ACCOUNT, { channel: 'ccip', settleChainId: 11155111, asset: 'TKA', createdAt: 1 })
    expect(consumeTempOverride(ACCOUNT, 84532, 'TKA')).toBeNull()
    const hit = consumeTempOverride(ACCOUNT, 11155111, 'TKA')
    expect(hit?.channel).toBe('ccip')
    expect(consumeTempOverride(ACCOUNT, 11155111, 'TKA')).toBeNull()
  })
})
