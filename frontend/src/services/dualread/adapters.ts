/**
 * 第 34 轮双读 — 两源订单簿适配器。
 *
 * - 节点适配器复用现行客户端 services/nodeClient.ts（nodeGet / tryNodes），
 *   合同 GET /api/orderbook?pair= → { pair, bids, asks }（全量开簿，无分页）。
 * - 公告栏适配器按 relay/ 的现行 API 合同实现：
 *   GET /orderbook?pair=<PAIR>&chain=<chainId> → { pair, generatedAt, bids, asks }
 *   （relay SQL 先取 400 行、仅 open/partial，两侧各截 100 行返回——单侧
 *   返回满 100 行即视为可能截断，分页完整度记 false）。
 *
 * 两源统一按 (链， 交易对， 方向） 组织，排序为稳定键
 * （买盘价降/卖盘价升，同价 createdAt 升序，digest 前的 orderId 兜底），
 * 并记录分页完整度；未拉完的数据不进完整性指标（见 metrics.ts）。
 */
import { nodeGet } from '../../nodeClient'
import { RELAY_URL } from '../../config/relay'
import type { RawOrder, SourceBook } from './types'

/** relay /orderbook 单侧返回上限（relay/src/index.ts 现行合同） */
export const RELAY_BOOK_SIDE_CAP = 100

function asIntString(v: unknown): string | null {
  if (typeof v === 'string') {
    const s = v.trim()
    if (/^-?\d+$/.test(s)) return s
    // 定点小数字符串：第 38 轮——节点撮合引擎以 big.Float.Text('f', 18)
    // 回写 amount/filled（如 "1000000000000000.000000000000000000"），
    // 小数部分全为零时归一化为整数串；含任何非零数字则判无效返回
    // null（走既有丢弃路径），绝不静默截断小数。
    const m = /^(-?\d+)\.(\d+)$/.exec(s)
    if (m && /^0+$/.test(m[2])) return m[1]
    return null
  }
  // 数字路径与字符串路径同口径（第 40 轮，第 38 轮复审 F1）：只有安全
  // 整数才接受；小数与超出安全整数范围的数字一律判无效返回 null——
  // 绝不 Math.trunc 静默截断，也不带着已丢失的精度过关（此前实现用
  // Math.trunc，数字 1.5 会被截成 "1"，与字符串 "1.5" 判无效矛盾）。
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v.toString() : null
  if (typeof v === 'bigint') return v.toString()
  return null
}

function asNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return 0
}

/** 任意源行 → RawOrder；缺签名/关键字段的行返回 null，由调用方经 normalizeBookRows 计数丢弃（见 SourceBook.droppedRows） */
export function toRawOrder(x: unknown): RawOrder | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  const orderId = typeof o.orderId === 'string' ? o.orderId : ''
  const trader = typeof o.trader === 'string' ? o.trader : typeof o.userAddress === 'string' ? o.userAddress : ''
  const pair = typeof o.pair === 'string' ? o.pair : ''
  const side = o.side === 'buy' || o.side === 'sell' ? o.side : null
  const price = asIntString(o.price)
  const amount = asIntString(o.amount)
  if (!orderId || !trader || !pair || !side || price === null || amount === null) return null
  return {
    orderId,
    trader,
    pair,
    side,
    price,
    amount,
    filled: asIntString(o.filled) ?? '0',
    status: typeof o.status === 'string' ? o.status : 'open',
    nonce: asNumber(o.nonce),
    createdAt: asNumber(o.createdAt ?? o.timestamp),
    expiresAt: asNumber(o.expiresAt),
    signature: typeof o.signature === 'string' ? o.signature : '',
    execType: typeof o.execType === 'string' ? o.execType : undefined,
  }
}

/**
 * 一批原始行 → 规范化订单 + 丢弃计数（第 38 轮）：三个取数点（前端节点
 * 适配器、前端中继适配器、soak 服务端节点适配器）共用，保证「整源被
 * 字段形态吞掉」时计数可见，不再静默归零。
 */
export function normalizeBookRows(rows: unknown[]): { orders: RawOrder[]; droppedRows: number } {
  const orders: RawOrder[] = []
  let droppedRows = 0
  for (const r of rows) {
    const o = toRawOrder(r)
    if (o) orders.push(o)
    else droppedRows += 1
  }
  return { orders, droppedRows }
}

/** 稳定排序：买盘价格降序、卖盘价格升序；同价 createdAt 升序；再以 orderId 兜底保证全序 */
export function sortBookSide(rows: RawOrder[], side: 'buy' | 'sell'): RawOrder[] {
  const sorted = [...rows]
  sorted.sort((a, b) => {
    const pa = BigInt(a.price || '0')
    const pb = BigInt(b.price || '0')
    if (pa !== pb) {
      const cmp = pa < pb ? -1 : 1
      return side === 'buy' ? -cmp : cmp
    }
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    return a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0
  })
  return sorted
}

export interface BookAdapter {
  fetchBook(chainId: number, pair: string): Promise<SourceBook>
}

type NodeGetFn = (
  path: string,
  params?: Record<string, string>,
) => Promise<{ data: { pair: string; bids: unknown[]; asks: unknown[] }; baseUrl: string }>

const defaultNodeGet: NodeGetFn = (path, params) =>
  nodeGet<{ pair: string; bids: unknown[]; asks: unknown[] }>(path, params)

/**
 * 节点订单簿响应的形态校验（第 40 轮，第 38 轮复审 F3）：响应必须是
 * 对象；bids/asks 缺失（undefined）按空数组处理（正常空盘口），存在
 * 但不是数组则抛错——按源错误走既有降级，绝不静默当空簿，也不让非
 * 数组流进 normalizeBookRows。前端节点适配器与 soak runner 的服务端
 * 节点适配器共用本函数，保证两侧同构。
 */
export function requireBookSides(
  data: unknown,
  sourceLabel: string,
): { bids: unknown[]; asks: unknown[] } {
  if (!data || typeof data !== 'object') {
    throw new Error(`${sourceLabel} orderbook response is not an object`)
  }
  const { bids, asks } = data as { bids?: unknown; asks?: unknown }
  if (bids !== undefined && !Array.isArray(bids)) {
    throw new Error(`${sourceLabel} orderbook bids is not an array`)
  }
  if (asks !== undefined && !Array.isArray(asks)) {
    throw new Error(`${sourceLabel} orderbook asks is not an array`)
  }
  return { bids: bids ?? [], asks: asks ?? [] }
}

/** 节点适配器（注入点便于单测；缺省走现行 nodeGet 多节点轮询） */
export function createNodeBookAdapter(get: NodeGetFn = defaultNodeGet): BookAdapter {
  return {
    async fetchBook(chainId: number, pair: string): Promise<SourceBook> {
      const { data } = await get('/api/orderbook', { pair })
      const { bids: rawBids, asks: rawAsks } = requireBookSides(data, 'node')
      const nb = normalizeBookRows(rawBids)
      const na = normalizeBookRows(rawAsks)
      const bids = sortBookSide(nb.orders, 'buy')
      const asks = sortBookSide(na.orders, 'sell')
      return {
        source: 'node',
        chainId,
        pair,
        bids,
        asks,
        // 节点 orderbook 接口一次性返回全量开簿，无分页概念
        complete: true,
        fetchedAt: Date.now(),
        rawRows: rawBids.length + rawAsks.length,
        droppedRows: nb.droppedRows + na.droppedRows,
      }
    },
  }
}

export type FetchFn = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** 公告栏适配器（注入 fetch 便于单测；缺省用全局 fetch 读 RELAY_URL） */
export function createRelayBookAdapter(
  baseUrl: string = RELAY_URL,
  fetchFn?: FetchFn,
): BookAdapter {
  const doFetch: FetchFn =
    fetchFn ??
    (async (url: string) => {
      const res = await fetch(url)
      return { ok: res.ok, status: res.status, json: () => res.json() }
    })
  return {
    async fetchBook(chainId: number, pair: string): Promise<SourceBook> {
      if (!baseUrl) throw new Error('relay url not configured')
      const url = `${baseUrl}/orderbook?pair=${encodeURIComponent(pair)}&chain=${chainId}`
      const res = await doFetch(url)
      if (!res.ok) throw new Error(`relay orderbook http ${res.status}`)
      const data = (await res.json()) as { bids?: unknown[]; asks?: unknown[] }
      const rawBids = Array.isArray(data?.bids) ? data.bids : []
      const rawAsks = Array.isArray(data?.asks) ? data.asks : []
      const nb = normalizeBookRows(rawBids)
      const na = normalizeBookRows(rawAsks)
      const bids = sortBookSide(nb.orders, 'buy')
      const asks = sortBookSide(na.orders, 'sell')
      return {
        source: 'relay',
        chainId,
        pair,
        bids,
        asks,
        // 单侧返回达上限 100 行 ⇒ 可能被 relay 截断，完整度存疑
        complete: rawBids.length < RELAY_BOOK_SIDE_CAP && rawAsks.length < RELAY_BOOK_SIDE_CAP,
        fetchedAt: Date.now(),
        rawRows: rawBids.length + rawAsks.length,
        droppedRows: nb.droppedRows + na.droppedRows,
      }
    },
  }
}
