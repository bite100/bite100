/**
 * 跨链默认桥 · 类型（第四十一轮，第一期）
 * 设计定版：docs/cross-chain-default-bridge-design-2026-11-08.md
 */
import type { MessageChannelId } from '../bridgeExecutors'

/** 第一期可选为默认的通道：只有三条消息桥（§11 定版第 2 条）；极速档待主网与 LI.FI key 就绪后补入 */
export type DefaultChannelId = MessageChannelId

/** 逐通道披露确认记录（§2.1 / §2.3）：文案改版后旧确认失效 */
export interface DisclosureConfirmation {
  channel: DefaultChannelId
  disclosureVersion: number
  confirmedAt: number
}

/** 无备选时的出厂处置（§6 三级 / §11 定版第 4 条）：默认「成交前问一次」 */
export type NoFallbackPref = 'ask' | 'settle-chain-only'

/** 每用户一份的默认桥设置（§2.1 数据模型；第一期不含 fallbackOrder——二级回退属第二期） */
export interface DefaultBridgeSettings {
  defaultChannel: DefaultChannelId | null
  /** 交付目标链（用户主场链） */
  homeChainId: number | null
  /** 常设交付授权（第一期 = 全量开关，随时可撤销，§11 定版第 3 条） */
  standingAuth: boolean
  noFallbackPref: NoFallbackPref
  confirmations: DisclosureConfirmation[]
}

/** 交付状态机（§1.2）：每笔成交 × 每个收款方一条 */
export type DeliveryStatus =
  | 'not-needed' // 无需交付（终态）
  | 'pending-decision' // 待交付判定后可发起
  | 'suspended-disclosure' // 披露已更新、待重新确认（挂起，款留成交链 Vault）
  | 'ask-required' // 默认桥不支持且无预授权，待用户抉择（绝不静默换桥）
  | 'initiating' // 交付发起中（提款 + 桥存入）
  | 'in-flight' // 交付中
  | 'delivered' // 已到账（终态）
  | 'anomaly' // 交付异常（终态，带落点说明与可执行操作）

export type AnomalyKind = 'initiation-failed' | 'timeout' | 'channel-failed'

export interface DeliveryRecord {
  /** 幂等键（§7.1）：`${tradeId}:${receiver 小写}` */
  id: string
  tradeId: string
  receiver: string
  settleChainId: number
  homeChainId: number
  pair: string
  /** 收款方实际收到的资产符号 */
  asset: string
  /** 收款金额（wei 十进制字符串） */
  amountWei: string
  channel: DefaultChannelId | null
  /** §8 选项 C 接口预留：第一期恒为桥通道 */
  executor: 'bridge'
  status: DeliveryStatus
  /** 实际桥费（源链原生币 wei 字符串）；与结算 gas 分开记账（§5） */
  feeNativeWei?: string
  trackingId?: string
  trackingUrl?: string
  txHash?: string
  initiatedAt?: number
  deliveredAt?: number
  anomalyKind?: AnomalyKind
  anomalyNote?: string
  /**
   * 资金当前在哪（发起失败后区分落点）：'vault' = 从未离开 Vault；
   * 'wallet' = 已提到钱包但桥存入失败（重试时从钱包余额发起，不再提款）。
   */
  fundsLocation?: 'vault' | 'wallet'
  /**
   * 异常落点是否已按 §7.3 记回成交链 Vault。
   * 只有在通道侧确认终局失败后才可置 true；在途超时绝不置 true（防双记账，§7.3）。
   * 第一期前端不自动置 true——记回由平台侧执行后回填。
   */
  fallbackCredited?: boolean
  createdAt: number
  updatedAt: number
}
