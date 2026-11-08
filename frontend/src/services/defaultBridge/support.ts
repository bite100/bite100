/**
 * 跨链默认桥 · 支持矩阵与路由判定（第四十一轮，第一期）
 *
 * 设计 §6：支持是三维的（桥 × 链对 × 资产），矩阵在上架时静态算出。
 * 第一期的真实集成边界（第 9/16/19 轮）：三条消息桥都只搬 TKA（CCIP / Wormhole
 * 经 wTKA 1:1 转换），链对只限已部署全套桥配置的 Sepolia ↔ Base Sepolia；
 * 其余资产（USDT 与主流币的测试代币、TKB）没有任何一条桥能搬——不许假装支持。
 * 链对可用性直接读 chains.ts 的桥配置字段判定（骑现成配置，不另维护一份链对表）。
 *
 * 路由判定（§1.2 交付判定 + §6 回退）：第一期只有一级（默认路径）与三级
 * （成交前询问 / 按用户预设只在成交链交付）；二级预授权备选属第二期，不在此实现。
 * 回退永不静默：判定结果里凡是没用上默认通道的，都带明示的 reason 供 UI 呈现。
 */
import { ZeroAddress } from 'ethers'
import { getChainConfig } from '../../config/chains'
import { messageBridgeAvailable, type MessageChannelId } from '../bridgeExecutors'
import { currentDisclosureVersion } from './disclosures'
import type { DefaultBridgeSettings, DefaultChannelId } from './types'

/** 第一期可交付资产：只有 TKA（三桥共同的载体资产，见文件头） */
export const DELIVERABLE_ASSETS: ReadonlySet<string> = new Set(['TKA'])

export function isDeliverableAsset(asset: string): boolean {
  return DELIVERABLE_ASSETS.has(asset)
}

/** 某通道在给定链对 + 资产下是否支持交付（静态矩阵的单元） */
export function channelSupports(
  channel: DefaultChannelId,
  fromChainId: number,
  toChainId: number,
  asset: string
): boolean {
  if (fromChainId === toChainId) return false
  if (!isDeliverableAsset(asset)) return false
  const sourceChain = getChainConfig(fromChainId)
  const targetChain = getChainConfig(toChainId)
  if (!sourceChain || !targetChain) return false
  // 资产必须在两条链的代币登记里都真实存在（主网配置无 tokens 登记 = 未部署，不许假装支持）
  if (!sourceChain.tokens?.[asset] || !targetChain.tokens?.[asset]) return false
  // LayerZero 的代币映射在两侧桥合约上，目标侧桥合约未部署（零地址）即不支持
  if (
    channel === 'layerzero' &&
    (!targetChain.contracts.crossChainBridge || targetChain.contracts.crossChainBridge === ZeroAddress)
  ) {
    return false
  }
  return messageBridgeAvailable(channel as MessageChannelId, { account: '', sourceChain, targetChain })
}

/** 在给定链对 + 资产下全部可用的通道（供三级询问时列选项） */
export function supportedChannelsFor(fromChainId: number, toChainId: number, asset: string): DefaultChannelId[] {
  const all: DefaultChannelId[] = ['layerzero', 'ccip', 'wormhole']
  return all.filter((c) => channelSupports(c, fromChainId, toChainId, asset))
}

/**
 * 交易对是否「仅同链交易」（§6 目录层红线）：基础与计价两侧资产都不可交付时，
 * 该对的任何一笔成交款都没法自动回家，上架呈现层须标注「仅同链交易」。
 */
export function pairSameChainOnly(pair: string): boolean {
  const [base, quote] = pair.split('/')
  if (!base || !quote) return true
  return !isDeliverableAsset(base) && !isDeliverableAsset(quote)
}

/** 用户对某通道是否有当前版本的有效披露确认（§2.3：改版后旧确认失效） */
export function hasValidConfirmation(settings: DefaultBridgeSettings, channel: DefaultChannelId): boolean {
  const rec = settings.confirmations.find((c) => c.channel === channel)
  return Boolean(rec) && rec!.disclosureVersion === currentDisclosureVersion(channel)
}

export type RouteDecision =
  | { kind: 'none'; reason: 'unset' | 'same-chain' | 'auth-off' | 'settle-chain-only-pref' | 'asset-unsupported' }
  | { kind: 'suspended-disclosure'; channel: DefaultChannelId }
  | { kind: 'default'; channel: DefaultChannelId }
  | { kind: 'ask'; supportedChannels: DefaultChannelId[] }

/**
 * 交付路由判定（纯函数）。入参是收款方视角：一笔已在 settleChainId 结算的成交，
 * 收款方将收到 asset，希望送回 settings.homeChainId。
 */
export function decideRoute(
  settings: DefaultBridgeSettings,
  settleChainId: number,
  asset: string
): RouteDecision {
  if (!settings.defaultChannel || !settings.homeChainId) return { kind: 'none', reason: 'unset' }
  if (settings.homeChainId === settleChainId) return { kind: 'none', reason: 'same-chain' }
  if (!settings.standingAuth) return { kind: 'none', reason: 'auth-off' }
  const channel = settings.defaultChannel
  if (!hasValidConfirmation(settings, channel)) return { kind: 'suspended-disclosure', channel }
  if (channelSupports(channel, settleChainId, settings.homeChainId, asset)) {
    return { kind: 'default', channel }
  }
  if (!isDeliverableAsset(asset)) {
    // 资产本身没有任何桥能搬：问了也没通道可选，不打断用户，明确标注为不可交付
    return { kind: 'none', reason: 'asset-unsupported' }
  }
  if (settings.noFallbackPref === 'settle-chain-only') return { kind: 'none', reason: 'settle-chain-only-pref' }
  return { kind: 'ask', supportedChannels: supportedChannelsFor(settleChainId, settings.homeChainId, asset) }
}
