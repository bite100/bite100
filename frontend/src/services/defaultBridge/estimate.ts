/**
 * 跨链默认桥 · 成交前一行预计（第四十一轮，第一期）
 *
 * 设计 §4.1：凡本次成交将产生跨链交付腿的，在下单区固定呈现一行——非弹窗、
 * 不要求点按、不阻断。费用与时间均为预计口径，最终以交付记录为准、不构成
 * 报价承诺（此口径在设置页说明中讲明）。唯一允许打断的形态是 §6 三级询问，
 * 它由本模块以 kind='ask' 暴露给下单区渲染抉择 UI，而不是一行预计。
 */
import { getChainConfig } from '../../config/chains'
import { etaShortTextFor, getDisclosure } from './disclosures'
import { decideRoute } from './support'
import type { DefaultBridgeSettings, DefaultChannelId } from './types'

export type OrderEstimate =
  | { kind: 'none' }
  | { kind: 'line'; text: string; channel: DefaultChannelId }
  | { kind: 'suspended'; text: string; channel: DefaultChannelId }
  | { kind: 'ask'; text: string; supportedChannels: DefaultChannelId[] }

/**
 * 按「我作为收款方将收到 receivedAsset」构建下单区呈现。
 * receivedAsset 由下单方向推得（买入收到基础币、卖出收到计价币）。
 */
export function buildOrderDeliveryEstimate(args: {
  settings: DefaultBridgeSettings
  settleChainId: number
  receivedAsset: string
}): OrderEstimate {
  const { settings, settleChainId, receivedAsset } = args
  const decision = decideRoute(settings, settleChainId, receivedAsset)
  const homeName = settings.homeChainId ? (getChainConfig(settings.homeChainId)?.name ?? `${settings.homeChainId}`) : ''
  switch (decision.kind) {
    case 'default': {
      const d = getDisclosure(decision.channel)
      return {
        kind: 'line',
        channel: decision.channel,
        text: `交付：成交款将经你的默认通道 ${d.name} 送回 ${homeName}，预计费用以交付时实时报价为准（由你从成交款承担），预计 ${etaShortTextFor(decision.channel, settleChainId)} 到账。`,
      }
    }
    case 'suspended-disclosure': {
      const d = getDisclosure(decision.channel)
      return {
        kind: 'suspended',
        channel: decision.channel,
        text: `交付待确认：${d.name} 的披露已更新，本笔成交款将先留在成交链 Vault，请到跨链桥页的默认通道设置里重新确认后补发。`,
      }
    }
    case 'ask': {
      const d = settings.defaultChannel ? getDisclosure(settings.defaultChannel) : null
      return {
        kind: 'ask',
        supportedChannels: decision.supportedChannels,
        text: `你的默认通道${d ? ` ${d.name}` : ''}不支持本笔成交款（${receivedAsset}）送回 ${homeName}。请选择本次的交付方式（只问这一次，绝不静默换桥）：`,
      }
    }
    case 'none':
      return { kind: 'none' }
  }
}
