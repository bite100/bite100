/**
 * 跨链默认桥 · 设置存储（第四十一轮，第一期）
 *
 * 设计 §2.1：每用户一份设置；存储位置随基础设施阶段走（现阶段前端侧记录，
 * 无节点阶段迁 D1），数据模型在本轮定死、不随存储位置变。
 * 常设授权载体（§2.1 留给实施轮定版的接口点）——本轮定版：**设置级常设授权**：
 * 本地记录 + 全量开关 + 逐通道披露确认即构成授权凭据；交付发起的每笔链上交易
 * （Vault 提款、桥存入）仍由用户钱包逐笔签名（Vault 无委托提款接口，加链上
 * opt-in 标记须另开合约轮并双链重部署，不在本期范围）。撤销 = 关开关或改选，
 * 立即对新成交生效，在途交付不受影响、必然走完（§2.1）。
 */
import { currentDisclosureVersion } from './disclosures'
import type { DefaultBridgeSettings, DefaultChannelId } from './types'

const KEY_PREFIX = 'bit100.defaultBridge.settings.v1.'

export function factorySettings(): DefaultBridgeSettings {
  return {
    defaultChannel: null,
    homeChainId: null,
    standingAuth: false,
    noFallbackPref: 'ask',
    confirmations: [],
  }
}

function storageKey(account: string): string {
  return KEY_PREFIX + account.toLowerCase()
}

export function loadSettings(account: string): DefaultBridgeSettings {
  if (!account) return factorySettings()
  try {
    const raw = localStorage.getItem(storageKey(account))
    if (!raw) return factorySettings()
    const parsed = JSON.parse(raw) as Partial<DefaultBridgeSettings>
    const base = factorySettings()
    return {
      defaultChannel: parsed.defaultChannel ?? base.defaultChannel,
      homeChainId: parsed.homeChainId ?? base.homeChainId,
      standingAuth: Boolean(parsed.standingAuth),
      noFallbackPref: parsed.noFallbackPref === 'settle-chain-only' ? 'settle-chain-only' : 'ask',
      confirmations: Array.isArray(parsed.confirmations) ? parsed.confirmations : [],
    }
  } catch {
    return factorySettings()
  }
}

export function saveSettings(account: string, settings: DefaultBridgeSettings): void {
  if (!account) return
  try {
    localStorage.setItem(storageKey(account), JSON.stringify(settings))
  } catch {
    // 存储不可用时静默：设置功能降级为会话内有效，不阻塞交易
  }
}

/** 记录一条当前版本的披露确认（§2.3 确认记录） */
export function confirmDisclosure(
  settings: DefaultBridgeSettings,
  channel: DefaultChannelId,
  now: number = Date.now()
): DefaultBridgeSettings {
  const rest = settings.confirmations.filter((c) => c.channel !== channel)
  return {
    ...settings,
    confirmations: [...rest, { channel, disclosureVersion: currentDisclosureVersion(channel), confirmedAt: now }],
  }
}

/**
 * 一次性临时通道授权（§6 三级在成交前问一次的落点）：用户在下单区当场选了
 * 临时通道后，编排器在该用户下一笔对应成交结算时消费它。用完即删，不落常设。
 */
const OVERRIDE_KEY_PREFIX = 'bit100.defaultBridge.tempOverride.v1.'

export interface TempChannelOverride {
  /** 'settle-chain-only' = 用户在成交前明确选了只在成交链交付（同样是一次性抉择，不落常设） */
  channel: DefaultChannelId | 'settle-chain-only'
  settleChainId: number
  asset: string
  createdAt: number
}

export function pushTempOverride(account: string, override: TempChannelOverride): void {
  if (!account) return
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY_PREFIX + account.toLowerCase())
    const list: TempChannelOverride[] = raw ? (JSON.parse(raw) as TempChannelOverride[]) : []
    list.push(override)
    localStorage.setItem(OVERRIDE_KEY_PREFIX + account.toLowerCase(), JSON.stringify(list))
  } catch {
    // 忽略：无覆盖时编排器按默认判定走
  }
}

export function consumeTempOverride(
  account: string,
  settleChainId: number,
  asset: string
): TempChannelOverride | null {
  if (!account) return null
  try {
    const key = OVERRIDE_KEY_PREFIX + account.toLowerCase()
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const list = JSON.parse(raw) as TempChannelOverride[]
    const idx = list.findIndex((o) => o.settleChainId === settleChainId && o.asset === asset)
    if (idx < 0) return null
    const [hit] = list.splice(idx, 1)
    localStorage.setItem(key, JSON.stringify(list))
    return hit
  } catch {
    return null
  }
}
