/**
 * 跨链默认桥 · 交付记录存储与状态机（第四十一轮，第一期）
 *
 * 设计 §1.2 状态机 + §7.1 幂等：每条记录以（成交 ID × 收款方）为幂等键，
 * 编排器重启/重扫凭键去重，同一笔成交款永不重复发起两次桥存入。
 * §7.3 双记账红线落在状态机上：只有 channel-failure-confirmed 事件能把
 * fallbackCredited 置 true；timeout 事件绝不置——在途的钱没有确认失败前，
 * 不能既算在途又算已退回。
 */
import type { AnomalyKind, DeliveryRecord, DeliveryStatus } from './types'

const KEY_PREFIX = 'bit100.defaultBridge.deliveries.v1.'

export function deliveryKey(tradeId: string, receiver: string): string {
  return `${tradeId}:${receiver.toLowerCase()}`
}

export function loadDeliveries(account: string): DeliveryRecord[] {
  if (!account) return []
  try {
    const raw = localStorage.getItem(KEY_PREFIX + account.toLowerCase())
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as DeliveryRecord[]) : []
  } catch {
    return []
  }
}

export function saveDeliveries(account: string, records: DeliveryRecord[]): void {
  if (!account) return
  try {
    localStorage.setItem(KEY_PREFIX + account.toLowerCase(), JSON.stringify(records))
  } catch {
    // 存储不可用时静默：记录降级为会话内有效
  }
}

/** 按幂等键 upsert；返回是否新建（false = 已有记录，编排器据此不重复发起） */
export function upsertDelivery(account: string, record: DeliveryRecord): { records: DeliveryRecord[]; created: boolean } {
  const records = loadDeliveries(account)
  const idx = records.findIndex((r) => r.id === record.id)
  if (idx >= 0) {
    records[idx] = record
    saveDeliveries(account, records)
    return { records, created: false }
  }
  records.push(record)
  saveDeliveries(account, records)
  return { records, created: true }
}

export function getDelivery(account: string, tradeId: string, receiver: string): DeliveryRecord | null {
  const id = deliveryKey(tradeId, receiver)
  return loadDeliveries(account).find((r) => r.id === id) ?? null
}

export type DeliveryEvent =
  | { type: 'initiate'; at: number }
  | { type: 'initiated'; at: number; txHash: string; trackingId: string; trackingUrl: string; feeNativeWei: string }
  | { type: 'delivered'; at: number }
  | { type: 'initiation-failed'; at: number; note: string }
  | { type: 'timeout'; at: number; note: string }
  | { type: 'channel-failure-confirmed'; at: number; note: string }
  | { type: 'resolve-settle-chain-only'; at: number }
  | { type: 'reconfirmed'; at: number }
  | { type: 'disclosure-invalidated'; at: number }
  | { type: 'retry'; at: number }
  | { type: 'choose-temp-channel'; at: number; channel: NonNullable<DeliveryRecord['channel']> }

const LEGAL: Record<DeliveryStatus, DeliveryEvent['type'][]> = {
  'not-needed': [],
  'pending-decision': ['initiate', 'resolve-settle-chain-only', 'disclosure-invalidated'],
  'suspended-disclosure': ['reconfirmed'],
  'ask-required': ['choose-temp-channel', 'resolve-settle-chain-only'],
  initiating: ['initiated', 'initiation-failed'],
  'in-flight': ['delivered', 'timeout', 'channel-failure-confirmed'],
  delivered: [],
  // 'initiated' 仅供第 63 轮桥-2 对账恢复：对账判定 found（发送交易已上链成功）时，
  // 卡在 anomaly 的记录凭链上事实直接恢复为在途，不经用户重试。
  anomaly: ['retry', 'initiated'],
}

/** 纯状态机：非法迁移抛错（调用方不得吞掉后假装成功） */
export function transition(record: DeliveryRecord, event: DeliveryEvent): DeliveryRecord {
  if (!LEGAL[record.status].includes(event.type)) {
    throw new Error(`交付状态非法迁移：${record.status} --${event.type}-->`)
  }
  // 重试只对「发起失败」开放（§7.3）：在途超时/通道失败的记录重试会造成双发风险
  if (event.type === 'retry' && record.anomalyKind !== 'initiation-failed') {
    throw new Error('只有发起失败的交付可以重试；在途异常请先走追踪与人工中继兜底')
  }
  // 第 63 轮桥-2（P1-①）：重试的唯一放行依据 = 对账结论 missing（确认上一笔发起
  // 未上链）。无结论 / unknown / found 一律拒绝——宁可让用户等对账，也不冒双投递风险。
  if (event.type === 'retry' && record.lastReconcile !== 'missing') {
    throw new Error('上一笔发起结果未确认（对账未判定 missing），为避免重复投递暂不能重试')
  }
  const next: DeliveryRecord = { ...record, updatedAt: event.at }
  switch (event.type) {
    case 'initiate':
      next.status = 'initiating'
      break
    case 'initiated':
      next.status = 'in-flight'
      next.txHash = event.txHash
      next.trackingId = event.trackingId
      next.trackingUrl = event.trackingUrl
      next.feeNativeWei = event.feeNativeWei
      next.initiatedAt = event.at
      break
    case 'delivered':
      next.status = 'delivered'
      next.deliveredAt = event.at
      break
    case 'initiation-failed':
      next.status = 'anomaly'
      next.anomalyKind = 'initiation-failed' satisfies AnomalyKind
      next.anomalyNote = event.note
      break
    case 'timeout':
      next.status = 'anomaly'
      next.anomalyKind = 'timeout' satisfies AnomalyKind
      next.anomalyNote = event.note
      // 注意：绝不在此置 fallbackCredited——在途未确认失败前不许双记账（§7.3）
      break
    case 'channel-failure-confirmed':
      next.status = 'anomaly'
      next.anomalyKind = 'channel-failed' satisfies AnomalyKind
      next.anomalyNote = event.note
      // fallbackCredited 不在此置 true：记回是平台侧的实际入账动作，第一期前端
      // 只登记落点、不冒充已入账；平台执行记回后由其回填该字段（§7.3）。
      break
    case 'resolve-settle-chain-only':
      next.status = 'not-needed'
      break
    case 'reconfirmed':
      next.status = 'pending-decision'
      break
    case 'disclosure-invalidated':
      // 披露升版后旧确认失效：待发起记录回挂起（与 reconfirmed 回路成对，第 63 轮桥-1）
      next.status = 'suspended-disclosure'
      break
    case 'retry':
      next.status = 'pending-decision'
      next.anomalyKind = undefined
      next.anomalyNote = undefined
      break
    case 'choose-temp-channel':
      next.status = 'pending-decision'
      next.channel = event.channel
      break
  }
  return next
}
