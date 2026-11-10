/**
 * 跨链交付登记 · 中继客户端（第 63 轮桥-3，P1-③）
 *
 * 交付登记的仲裁面在中继 D1（relay/src/deliveries.ts）：发起桥存入前先
 * claim 占位，执行后 report 结果。本模块只是它的 HTTP 客户端。
 *
 * 失败口径（不对称，是有意的）：
 * - claim 是**闸门**：中继未配置 / 不可达 / 冲突 → 抛错，调用方必须中止
 *   发起（fail-closed）。宁可这次不发，也不在没有仲裁的情况下发——那正是
 *   P1-③ 要堵的跨设备重复投递。
 * - report 是**记账**：链上动作已经发生，汇报失败绝不能把已发生的交付标成
 *   失败；调用方一律 best-effort 吞掉（本地记录仍可经对账恢复）。
 *
 * 本地 localStorage 自此降级为展示缓存：状态的最终仲裁在中继登记，
 * 本地记录只负责界面呈现与链上对账（桥-2）的输入。
 */
import { RELAY_URL } from '../../config/relay'

export type RegistryDeliveryState = 'claimed' | 'initiated' | 'delivered' | 'anomaly' | 'closed'

export interface RegistryDeliveryRow {
  deliveryId: string
  account: string
  state: RegistryDeliveryState
  attemptId: string | null
  channel: string | null
  sendTxHash: string | null
  trackingId: string | null
  note: string | null
  /** 第 63 轮修复批（P1-2）：行内最近一次对账结论；anomaly 行凭 missing 才释放 */
  lastReconcile: 'found' | 'missing' | 'unknown' | null
  /** 第 63 轮修复批（P1-2）：行内是否已有广播证据（有则永不被接管） */
  broadcastEvidence: boolean
  createdAt: number
  updatedAt: number
}

export interface ClaimInput {
  deliveryId: string
  account: string
  attemptId: string
  channel?: string | null
  supersede?: boolean
}

export interface ClaimOutcome {
  row: RegistryDeliveryRow
  duplicate: boolean
  takeover: boolean
  reclaimed: boolean
}

export interface ReportInput {
  deliveryId: string
  account: string
  attemptId: string
  state: Exclude<RegistryDeliveryState, 'claimed'>
  sendTxHash?: string
  trackingId?: string
  note?: string
  /** 第 63 轮修复批（P1-2）：链上对账结论，随汇报落中继行 last_reconcile */
  reconcile?: 'found' | 'missing' | 'unknown'
  /** 第 63 轮修复批（P1-2）：显式广播证据标记（预取追踪 ID 单独构成证据时） */
  broadcastEvidence?: boolean
}

export interface DeliveryRegistry {
  claim(input: ClaimInput): Promise<ClaimOutcome>
  report(input: ReportInput): Promise<void>
  get(deliveryId: string): Promise<RegistryDeliveryRow | null>
  listByAccount(account: string): Promise<RegistryDeliveryRow[]>
}

/** 中继登记冲突：已有未终局认领（跨设备/跨页面正在执行同一笔交付） */
export class RegistryConflictError extends Error {
  existing?: RegistryDeliveryRow
  constructor(message: string, existing?: RegistryDeliveryRow) {
    super(message)
    this.name = 'RegistryConflictError'
    this.existing = existing
  }
}

/** 中继未配置或不可达：claim 必须 fail-closed 中止发起 */
export class RegistryUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RegistryUnavailableError'
  }
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export function createHttpRegistry(baseUrl: string = RELAY_URL, fetchFn: FetchFn = fetch): DeliveryRegistry {
  const base = baseUrl.replace(/\/$/, '')

  async function post(path: string, body: unknown): Promise<Response> {
    if (!base) {
      throw new RegistryUnavailableError('中继未配置，交付登记不可用：为防跨设备重复投递，本次发起已阻止')
    }
    try {
      return await fetchFn(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (e) {
      throw new RegistryUnavailableError(
        `中继不可达，交付登记失败：为防跨设备重复投递，本次发起已阻止（${e instanceof Error ? e.message : String(e)}）`
      )
    }
  }

  return {
    async claim(input: ClaimInput): Promise<ClaimOutcome> {
      const res = await post('/deliveries/claim', input)
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean
        delivery?: RegistryDeliveryRow
        duplicate?: boolean
        takeover?: boolean
        reclaimed?: boolean
        message?: string
        existing?: RegistryDeliveryRow
      } | null
      if (res.status === 409) {
        throw new RegistryConflictError(
          data?.message ?? '该笔交付已在另一设备/页面执行中（中继登记冲突），已阻止重复发起',
          data?.existing
        )
      }
      if (!res.ok || !data?.delivery) {
        throw new RegistryUnavailableError(`交付登记失败（HTTP ${res.status}），本次发起已阻止`)
      }
      return {
        row: data.delivery,
        duplicate: Boolean(data.duplicate),
        takeover: Boolean(data.takeover),
        reclaimed: Boolean(data.reclaimed),
      }
    },

    async report(input: ReportInput): Promise<void> {
      const res = await post('/deliveries/report', input)
      if (!res.ok) {
        // 汇报失败只抛给调用方记日志（调用方 best-effort 吞掉）；409 的迟到
        // 汇报（attempt 已被接管）同样不影响本地状态——新尝试自会汇报。
        throw new Error(`交付汇报失败（HTTP ${res.status}）`)
      }
    },

    async get(deliveryId: string): Promise<RegistryDeliveryRow | null> {
      if (!base) return null
      try {
        const res = await fetchFn(`${base}/deliveries?deliveryId=${encodeURIComponent(deliveryId)}`)
        if (res.status === 404) return null
        if (!res.ok) return null
        return (await res.json()) as RegistryDeliveryRow
      } catch {
        return null
      }
    },

    async listByAccount(account: string): Promise<RegistryDeliveryRow[]> {
      if (!base) return []
      try {
        const res = await fetchFn(`${base}/deliveries?account=${encodeURIComponent(account)}&limit=200`)
        if (!res.ok) return []
        const data = (await res.json()) as RegistryDeliveryRow[]
        return Array.isArray(data) ? data : []
      } catch {
        return []
      }
    },
  }
}

/** 生产默认登记（指向站点配置的中继）；测试经 ExecuteDeps.registry 注入替身 */
export const defaultRegistry: DeliveryRegistry = createHttpRegistry()
