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
  // —— 第 63 轮桥-2（P1-① 重复投递防护）：发起意图凭证与对账 ——
  /** 本次发起序号（从 1 起），每次进入 initiating +1 */
  attemptCount?: number
  /** 本次发起的意图凭证 ID：`${record.id}#${attemptCount}`，发起前先落盘 */
  attemptId?: string
  /** 桥发送交易 hash：广播瞬间经执行器钩子落盘（先于等回执），崩溃后可据此对账 */
  sendTxHash?: string
  /** Vault 提款交易 hash：广播瞬间落盘（先于等回执） */
  withdrawTxHash?: string
  /** CCIP 静态预取的消息 ID：正式发送前落盘，恢复 initiating 记录时用作追踪 ID */
  prefetchTrackingId?: string
  /**
   * 是否存在「可能已广播但结果未落定」的发起：发起前置 true；确认上链（initiated）
   * 或对账判定 missing 后置 false。为 true 的记录重试前必须先对账。
   */
  initiatedTxPending?: boolean
  /**
   * 最近一次对账结论：found = 发送交易已上链成功；missing = 确认未上链（可安全
   * 重试的唯一依据）；unknown = 证据不足，禁止重试。第一方事实（本会话内未发生
   * 任何广播即失败）也可直接记 missing。
   */
  lastReconcile?: 'missing' | 'found' | 'unknown'
  /** 最近一次对账时间 */
  lastReconcileAt?: number
  createdAt: number
  updatedAt: number
}
