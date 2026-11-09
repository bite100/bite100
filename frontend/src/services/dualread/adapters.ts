/**
 * 第 34 轮双读建立的订单簿适配器层；第 51 轮（阶段 5 节点退役）改为
 * 中继单源：节点适配器随节点下线删除，本文件只剩公告栏中继适配器。
 *
 * - 中继适配器按 relay/ 的现行 API 合同实现：
 *   GET /orderbook?pair=<PAIR>&chain=<chainId> → { pair, generatedAt, bids, asks }
 *   （relay SQL 先取 400 行、仅 open/partial，两侧各截 100 行返回——单侧
 *   返回满 100 行即视为可能截断，分页完整度记 false）。
 *
 * - 块 3 根因修复（第 45 轮挂账）：缺省 fetch 必须带显式超时。第 45 轮
 *   查明「阶段 4 运行器挂死」的根因嫌疑为本适配器缺省 fetch 无超时——
 *   fetch 本身没有默认超时，对端永不响应时 fetchBook 永远不 settle。
 *   当时只在运行器侧注入了带超时的 fetch 绕行，产品缺省路径仍无界；
 *   第 51 轮给缺省 fetch 补 AbortController + RELAY_BOOK_TIMEOUT_MS，
 *   并有「对端永不响应时在截止期内失败」的单测钉住（dualread.test.ts）。
 *   第 52 轮 A2 补完：计时须覆盖到响应体读完——第 51 轮实现在响应头
 *   到达后即清计时，fetchBook 随后 res.json() 已在计时之外，响应体
 *   卡死仍无限等待（根因变体）；现行 timer 只在 json() 落定后清理。
 *   注入 fetchFn 的调用方自带超时纪律（如 TradeTabsPanel 的 10s
 *   timedFetch、阶段 4 运行器的 30s 包装），不受影响。
 *
 * - 第 52 轮 A1（交易对隔离）：中继返回行逐行校验 pair 必须等于请求
 *   交易对——中继按 query 参数过滤只是它的说法，本层不轻信：跨对行
 *   若混入，其验签代币对又是从行自称 pair 推导的，会自洽验真后混进
 *   请求对的可成交集。不符行丢弃并单独计入 SourceBook.pairMismatchRows
 *   （与规范化丢弃 droppedRows 分开计数，语义不混）。
 *
 * 排序为稳定键（买盘价降/卖盘价升，同价 createdAt 升序，orderId 兜底），
 * 并记录分页完整度；未拉完的数据不进可成交集（评估层 SOURCE_INCOMPLETE 口径）。
 */
import { RELAY_URL } from '../../config/relay'
import type { RawOrder, SourceBook } from './types'

/** relay /orderbook 单侧返回上限（relay/src/index.ts 现行合同） */
export const RELAY_BOOK_SIDE_CAP = 100

/** 中继订单簿读取的缺省超时（ms）：对端在此时间内无响应即失败（第 51 轮，块 3） */
export const RELAY_BOOK_TIMEOUT_MS = 10_000

/** 负零规范化（第 40 轮复审跟进）：数字 -0 经 toString 得 "0"，字符串
 * "-0" 若原样保留则两路不一致；整数形态与定点形态的整数部分统一把
 * "-0"/"-00…" 归一为 "0"（数值等价，只动表示）。 */
function canonIntString(s: string): string {
  return /^-0+$/.test(s) ? '0' : s
}

function asIntString(v: unknown): string | null {
  if (typeof v === 'string') {
    const s = v.trim()
    if (/^-?\d+$/.test(s)) return canonIntString(s)
    // 定点小数字符串：第 38 轮——撮合引擎以 big.Float.Text('f', 18)
    // 回写 amount/filled（如 "1000000000000000.000000000000000000"），
    // 小数部分全为零时归一化为整数串；含任何非零数字则判无效返回
    // null（走既有丢弃路径），绝不静默截断小数。
    const m = /^(-?\d+)\.(\d+)$/.exec(s)
    if (m && /^0+$/.test(m[2])) return canonIntString(m[1])
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
 * 一批原始行 → 规范化订单 + 丢弃计数（第 38 轮）：中继适配器与产品各
 * 取数点共用，保证「整源被字段形态吞掉」时计数可见，不再静默归零。
 *
 * droppedRows 的口径是「规范化阶段丢弃数」（第 40 轮，第 38 轮复审 F4
 * 写明）：只数 toRawOrder 返回 null 的行；后续 digest 重构失败、验签
 * 失败、链上状态判无效的订单不在此列——那些走评估层 validity 口径，
 * 不回填本计数（见 types.ts SourceBook.droppedRows）。
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

/**
 * 订单簿响应的形态校验（第 40 轮，第 38 轮复审 F3）：响应必须是对象；
 * bids/asks 缺失（undefined）按空数组处理（正常空盘口），存在但不是
 * 数组则抛错——按源错误走既有降级，绝不静默当空簿，也不让非数组流进
 * normalizeBookRows。
 */
export function requireBookSides(
  data: unknown,
  sourceLabel: string,
): { bids: unknown[]; asks: unknown[] } {
  // 顶层数组也是 object（第 40 轮复审跟进）：不先排除数组，解构出的
  // bids/asks 恒为 undefined，会被误当成空盘口——按源错误抛错。
  if (Array.isArray(data)) {
    throw new Error(`${sourceLabel} orderbook response is a top-level array`)
  }
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

export type FetchFn = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export interface RelayBookAdapterOptions {
  /** 缺省 fetch 的超时（ms）；仅在未注入 fetchFn 时生效 */
  timeoutMs?: number
}

/** 公告栏适配器（注入 fetch 便于单测；缺省用全局 fetch 读 RELAY_URL，自带显式超时） */
export function createRelayBookAdapter(
  baseUrl: string = RELAY_URL,
  fetchFn?: FetchFn,
  options?: RelayBookAdapterOptions,
): BookAdapter {
  const timeoutMs = options?.timeoutMs ?? RELAY_BOOK_TIMEOUT_MS
  const doFetch: FetchFn =
    fetchFn ??
    (async (url: string) => {
      // 块 3 根因修复 + 第 52 轮 A2：fetch 无默认超时——AbortController
      // 在截止期到时 abort；且计时必须覆盖到响应体读完：第 51 轮实现
      // 在响应头到达后即 clearTimeout，fetchBook 随后 res.json() 已在
      // 计时之外，「头到、体永不到」仍会无限等待。现行：timer 只在
      // json() 落定（完成或失败）后清理；头阶段失败由 catch 清理。
      // json() 从未被调用的路径（调用方见 !ok 先抛错）下 timer 会在
      // timeoutMs 到点自熄——对已完成的响应 abort 无副作用，上界仍在。
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetch(url, { signal: controller.signal })
        return {
          ok: res.ok,
          status: res.status,
          json: async () => {
            try {
              return await res.json()
            } finally {
              clearTimeout(timer)
            }
          },
        }
      } catch (e) {
        clearTimeout(timer)
        throw e
      }
    })
  return {
    async fetchBook(chainId: number, pair: string): Promise<SourceBook> {
      if (!baseUrl) throw new Error('relay url not configured')
      const url = `${baseUrl}/orderbook?pair=${encodeURIComponent(pair)}&chain=${chainId}`
      const res = await doFetch(url)
      if (!res.ok) throw new Error(`relay orderbook http ${res.status}`)
      const data = await res.json()
      // requireBookSides 口径（第 40 轮 F3）：顶层非对象/数组、或
      // bids/asks 存在但非数组 → 抛错按源错误处理，不静默当空簿；
      // 字段缺失才按空盘口。
      const { bids: rawBids, asks: rawAsks } = requireBookSides(data, 'relay book')
      const nb = normalizeBookRows(rawBids)
      const na = normalizeBookRows(rawAsks)
      // 第 52 轮 A1：逐行 pair 隔离——只收行自称 pair 与请求 pair 一致
      // 的行；跨对行丢弃并单独计数（pairMismatchRows），不与规范化
      // 阶段的 droppedRows 混计（两者成因与处置口径不同）。
      const bidsInPair = nb.orders.filter((o) => o.pair === pair)
      const asksInPair = na.orders.filter((o) => o.pair === pair)
      const pairMismatchRows =
        nb.orders.length - bidsInPair.length + (na.orders.length - asksInPair.length)
      const bids = sortBookSide(bidsInPair, 'buy')
      const asks = sortBookSide(asksInPair, 'sell')
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
        pairMismatchRows,
      }
    },
  }
}
