/**
 * 跨链交付登记（第 63 轮桥-3，P1-③）：claim / report 两步登记。
 *
 * 背景（设计包 §1.3）：第 41 轮的交付防重复只活在单设备 localStorage——同一
 * 钱包换设备/换浏览器/清缓存后，同一笔成交款会被第二次发起桥存入。登记表把
 * 仲裁面搬到中继 D1：执行者发起前先 claim（原子占位），执行后 report 结果；
 * 同一 delivery_id 处于 claimed/initiated/delivered 时，第二个 claim 一律 409。
 *
 * 口径与既有模块一致：account 自报（中继无鉴权，与 pairs.creator 同口径，不
 * 构成身份背书）；防线是状态机本身，不是身份。delivered 是终局占位（已交付
 * 的同一笔永不许再认领）；anomaly/closed 释放占位，允许新尝试重新 claim。
 *
 * 认领接管（takeover）：claim 方崩溃且从未 report 时占位会悬空——claim 可带
 * supersede=true 申请接管，但服务端只对「占位已陈旧（updated_at 超过
 * TAKEOVER_AFTER_SEC）」的 claimed/initiated 行放行，且用 attempt_id 做
 * 条件 UPDATE 防竞态；新鲜占位一律 409，宁可让用户等，也不冒双投递风险。
 */

export type DeliveryState = 'claimed' | 'initiated' | 'delivered' | 'anomaly' | 'closed'

export interface DeliveryRow {
  deliveryId: string
  account: string
  state: DeliveryState
  attemptId: string | null
  channel: string | null
  sendTxHash: string | null
  trackingId: string | null
  note: string | null
  createdAt: number
  updatedAt: number
}

interface DeliveryDbRow {
  delivery_id: string
  account: string
  state: DeliveryState
  attempt_id: string | null
  channel: string | null
  send_tx_hash: string | null
  tracking_id: string | null
  note: string | null
  created_at: number
  updated_at: number
}

export class DeliveryRequestError extends Error {
  status: number
  /** 409 时附带的既有登记信息（供客户端如实提示） */
  existing?: DeliveryRow
  constructor(message: string, status: number, existing?: DeliveryRow) {
    super(message)
    this.status = status
    this.existing = existing
  }
}

/** 占位接管的陈旧门槛（秒）：正常一笔交付执行在分钟级，30 分钟足够宽容 */
export const TAKEOVER_AFTER_SEC = 30 * 60

const BLOCKING_STATES: DeliveryState[] = ['claimed', 'initiated', 'delivered']
const CHANNELS = new Set(['layerzero', 'ccip', 'wormhole'])
const ACCOUNT_RE = /^0x[0-9a-fA-F]{40}$/

/** report 的合法迁移（from 含同态幂等重报）；claimed 只能由 claim 产生，不可 report。
 * initiated 允许从 anomaly 修正：桥发送已广播但回执等待失败时先报 anomaly 释放
 * 认领，事后对账（前端桥-2）确认上链成功后，同一 attempt 再报 initiated 修正——
 * attempt_id 相同才许，原子条件 UPDATE 保证旧尝试覆盖不了新尝试。 */
const REPORT_TRANSITIONS: Record<Exclude<DeliveryState, 'claimed'>, DeliveryState[]> = {
  initiated: ['claimed', 'initiated', 'anomaly'],
  delivered: ['initiated', 'delivered'],
  anomaly: ['claimed', 'initiated', 'anomaly'],
  closed: ['claimed', 'initiated', 'anomaly', 'closed'],
}

function rowFromDb(r: DeliveryDbRow): DeliveryRow {
  return {
    deliveryId: r.delivery_id,
    account: r.account,
    state: r.state,
    attemptId: r.attempt_id,
    channel: r.channel,
    sendTxHash: r.send_tx_hash,
    trackingId: r.tracking_id,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

async function readRow(db: D1Database, deliveryId: string): Promise<DeliveryRow | null> {
  const r = await db
    .prepare('SELECT * FROM deliveries WHERE delivery_id = ?')
    .bind(deliveryId)
    .first<DeliveryDbRow>()
  return r ? rowFromDb(r) : null
}

function validateCommon(deliveryId: unknown, account: unknown, attemptId: unknown): {
  deliveryId: string
  account: string
  attemptId: string
} {
  if (typeof deliveryId !== 'string' || deliveryId.length < 3 || deliveryId.length > 220 || !deliveryId.includes(':')) {
    throw new DeliveryRequestError('invalid deliveryId', 400)
  }
  if (typeof account !== 'string' || !ACCOUNT_RE.test(account)) {
    throw new DeliveryRequestError('invalid account', 400)
  }
  if (typeof attemptId !== 'string' || attemptId.length < 1 || attemptId.length > 260) {
    throw new DeliveryRequestError('invalid attemptId', 400)
  }
  return { deliveryId, account: account.toLowerCase(), attemptId }
}

export interface ClaimInput {
  deliveryId: unknown
  account: unknown
  attemptId: unknown
  channel?: unknown
  supersede?: unknown
}

export interface ClaimResult {
  row: DeliveryRow
  /** 同 attempt 重复 claim（幂等） */
  duplicate: boolean
  /** 本次 claim 接管了陈旧占位 */
  takeover: boolean
  /** 本次 claim 释放了 anomaly/closed 的旧行重新占位 */
  reclaimed: boolean
}

export async function claimDelivery(
  db: D1Database,
  input: ClaimInput,
  now: number,
): Promise<ClaimResult> {
  const { deliveryId, account, attemptId } = validateCommon(input.deliveryId, input.account, input.attemptId)
  const channel =
    typeof input.channel === 'string' && CHANNELS.has(input.channel) ? input.channel : null
  const supersede = input.supersede === true

  // 原子占位（骑第 62 轮块 D 条件 INSERT 同款）：无阻塞行时才插入
  const ins = await db
    .prepare(
      `INSERT OR IGNORE INTO deliveries
         (delivery_id, account, state, attempt_id, channel, created_at, updated_at)
       SELECT ?, ?, 'claimed', ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM deliveries
          WHERE delivery_id = ? AND state IN ('claimed', 'initiated', 'delivered')
       )`,
    )
    .bind(deliveryId, account, attemptId, channel, now, now, deliveryId)
    .run()
  if ((ins.meta.changes ?? 0) > 0) {
    const row = await readRow(db, deliveryId)
    // 新插入，或对 anomaly/closed 旧行的 PK 冲突被 OR IGNORE 吞掉——后者读到旧行走下方重占路径
    if (row && row.attemptId === attemptId && row.state === 'claimed') {
      return { row, duplicate: false, takeover: false, reclaimed: false }
    }
  }

  const existing = await readRow(db, deliveryId)
  if (!existing) {
    // 插入未生效且无行：只可能并发竞态下另一请求刚建行又删行——按冲突处理
    throw new DeliveryRequestError('delivery claim conflict', 409)
  }
  if (existing.attemptId === attemptId && BLOCKING_STATES.includes(existing.state)) {
    return { row: existing, duplicate: true, takeover: false, reclaimed: false }
  }
  if (existing.state === 'anomaly' || existing.state === 'closed') {
    // 旧行已释放：条件 UPDATE 重新占位（以读到的 attempt_id 为竞态护栏）
    const upd = await db
      .prepare(
        `UPDATE deliveries
            SET state = 'claimed', attempt_id = ?, account = ?, channel = ?,
                send_tx_hash = NULL, tracking_id = NULL, note = NULL, updated_at = ?
          WHERE delivery_id = ? AND attempt_id IS ? AND state IN ('anomaly', 'closed')`,
      )
      .bind(attemptId, account, channel, now, deliveryId, existing.attemptId)
      .run()
    if ((upd.meta.changes ?? 0) > 0) {
      const row = await readRow(db, deliveryId)
      return { row: row!, duplicate: false, takeover: false, reclaimed: true }
    }
    const again = await readRow(db, deliveryId)
    throw new DeliveryRequestError('delivery already in flight', 409, again ?? existing)
  }
  if (BLOCKING_STATES.includes(existing.state) && existing.state !== 'delivered') {
    if (supersede && now - existing.updatedAt >= TAKEOVER_AFTER_SEC) {
      const upd = await db
        .prepare(
          `UPDATE deliveries
              SET state = 'claimed', attempt_id = ?, account = ?, channel = ?,
                  send_tx_hash = NULL, tracking_id = NULL,
                  note = 'takeover: superseded stale claim', updated_at = ?
            WHERE delivery_id = ? AND attempt_id IS ? AND state IN ('claimed', 'initiated')`,
        )
        .bind(attemptId, account, channel, now, deliveryId, existing.attemptId)
        .run()
      if ((upd.meta.changes ?? 0) > 0) {
        const row = await readRow(db, deliveryId)
        return { row: row!, duplicate: false, takeover: true, reclaimed: false }
      }
      const again = await readRow(db, deliveryId)
      throw new DeliveryRequestError('delivery already in flight', 409, again ?? existing)
    }
    throw new DeliveryRequestError('delivery already in flight', 409, existing)
  }
  // delivered 终局占位：永不释放、永不接管
  throw new DeliveryRequestError('delivery already delivered', 409, existing)
}

export interface ReportInput {
  deliveryId: unknown
  account: unknown
  attemptId: unknown
  state: unknown
  sendTxHash?: unknown
  trackingId?: unknown
  note?: unknown
}

export async function reportDelivery(
  db: D1Database,
  input: ReportInput,
  now: number,
): Promise<DeliveryRow> {
  const { deliveryId, attemptId } = validateCommon(input.deliveryId, input.account, input.attemptId)
  const target = input.state
  if (typeof target !== 'string' || !(target in REPORT_TRANSITIONS)) {
    throw new DeliveryRequestError('invalid report state', 400)
  }
  const to = target as Exclude<DeliveryState, 'claimed'>
  const fromStates = REPORT_TRANSITIONS[to]
  const optStr = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 && v.length <= 500 ? v : null

  const upd = await db
    .prepare(
      `UPDATE deliveries
          SET state = ?,
              send_tx_hash = COALESCE(?, send_tx_hash),
              tracking_id = COALESCE(?, tracking_id),
              note = COALESCE(?, note),
              updated_at = ?
        WHERE delivery_id = ? AND attempt_id = ?
          AND state IN (${fromStates.map(() => '?').join(', ')})`,
    )
    .bind(
      to,
      optStr(input.sendTxHash),
      optStr(input.trackingId),
      optStr(input.note),
      now,
      deliveryId,
      attemptId,
      ...fromStates,
    )
    .run()
  if ((upd.meta.changes ?? 0) === 0) {
    const existing = await readRow(db, deliveryId)
    if (!existing) throw new DeliveryRequestError('delivery not claimed', 404)
    if (existing.attemptId !== attemptId) {
      throw new DeliveryRequestError('attempt mismatch: report from a stale attempt', 409, existing)
    }
    throw new DeliveryRequestError(`invalid delivery transition: ${existing.state} -> ${to}`, 409, existing)
  }
  const row = await readRow(db, deliveryId)
  return row!
}

export async function getDelivery(db: D1Database, deliveryId: string): Promise<DeliveryRow | null> {
  if (typeof deliveryId !== 'string' || deliveryId.length < 3 || deliveryId.length > 220) {
    throw new DeliveryRequestError('invalid deliveryId', 400)
  }
  return readRow(db, deliveryId)
}

export async function listDeliveries(
  db: D1Database,
  account: string,
  limit: number,
): Promise<DeliveryRow[]> {
  if (!ACCOUNT_RE.test(account)) throw new DeliveryRequestError('invalid account', 400)
  const { results } = await db
    .prepare('SELECT * FROM deliveries WHERE account = ? ORDER BY updated_at DESC LIMIT ?')
    .bind(account.toLowerCase(), limit)
    .all<DeliveryDbRow>()
  return (results ?? []).map(rowFromDb)
}
