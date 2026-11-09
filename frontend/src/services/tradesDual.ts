/**
 * 成交记录读取：第 34 轮建立时为「节点 API + Envio 索引」双源合并；
 * 第 51 轮（无节点阶段 5 节点退役）改为链上索引单源。
 *
 * 口径（Ren 2026-11-09 定版）：链是唯一账本，索引（Envio）只是网页的
 * 展示缓存——成交记录直接读索引的链上 Trade 事件，不再与节点记录做
 * 去重/冲突合并（节点的成交记录随节点下线一并退役）。索引不可达时
 * 界面如实显示「暂不可用」，绝不拿空数据冒充「暂无成交」。
 *
 * 文件名 tradesDual 沿用以保持 import 路径稳定；导出 fetchIndexerTrades
 * / IndexerTrade 被 scripts/stage4 等已关闭的验收工具引用，不得改签名。
 */
import { INDEXER_URL } from '../config/indexer'
import { getPairTokens } from '../config/pairs'

/** Envio Trade 实体归一化行 */
export interface IndexerTrade {
  id: string
  chainId: number
  txHash: string
  logIndex: number
  blockTimestamp: number
  maker: string
  taker: string
  tokenIn: string
  tokenOut: string
  amountIn: string
  amountOut: string
  feeAmount: string
  makerDigest: string | null
  takerDigest: string | null
}

/** 展示用成交行（价格/数量已换算为人类单位数值，时间戳为链上区块时间） */
export interface DisplayTrade {
  /** 链上身份 (chainId-txHash-logIndex) */
  key: string
  price: number
  amount: number
  timestamp: number
  txHash: string
  logIndex: number
  maker: string
  taker: string
}

const lc = (s: string) => (s ?? '').toLowerCase()

function scaledToNumber(v: string): number {
  try {
    const bi = BigInt(v)
    return Number(bi) / 1e18
  } catch {
    const n = Number(v)
    return Number.isFinite(n) ? n / 1e18 : 0
  }
}

/** 价格/数量展示换算（price 为计价/基础，amount 为基础币数量） */
function displayValues(
  tokenIn: string,
  amountIn: string,
  amountOut: string,
  baseToken: string,
): { price: number; amount: number } {
  const inN = scaledToNumber(amountIn)
  const outN = scaledToNumber(amountOut)
  if (lc(tokenIn) === lc(baseToken)) {
    // 卖出基础币：数量 = amountIn，价格 = amountOut / amountIn
    return { price: inN > 0 ? outN / inN : 0, amount: inN }
  }
  // 买入基础币：数量 = amountOut，价格 = amountIn / amountOut
  return { price: outN > 0 ? inN / outN : 0, amount: outN }
}

/** 索引行 → 展示行（baseToken 为交易对的基础代币地址） */
export function indexerTradeToDisplay(t: IndexerTrade, baseToken: string): DisplayTrade {
  const { price, amount } = displayValues(t.tokenIn, t.amountIn, t.amountOut, baseToken)
  return {
    key: t.id,
    price,
    amount,
    timestamp: t.blockTimestamp,
    txHash: t.txHash,
    logIndex: t.logIndex,
    maker: t.maker,
    taker: t.taker,
  }
}

/**
 * 第 35 轮 D5：交易对过滤下沉到 GraphQL where（旧实现只按 chainId 拉全链
 * 最近 N 笔、再在浏览器按代币对筛——热门对会把冷门对挤出窗口，页面误显
 * 「暂无成交」）。索引实体只有代币地址、无 pair 符号：以 (tokenIn, tokenOut)
 * 的两个方向组合匹配本对地址集合。地址大小写双保险：Envio 落库大小写
 * 依版本而定，变量同时带配置原样与小写两种形态（_in 集合），客户端再
 * 保留一层精确集合校验作兜底。分页沿用本文件既有 Hasura 口径
 * （order_by + limit + offset）。
 *
 * 第 39 轮：服务端排序补次级键 logIndex desc（Hasura 多字段排序）——
 * 同块多笔成交时分页边界确定，与客户端 (timestamp, logIndex) 排序口径对齐。
 */
export const TRADES_QUERY = `
query Bit100Trades($chainId: Int!, $limit: Int!, $offset: Int!, $base: [String!], $quote: [String!]) {
  Trade(
    where: {
      chainId: { _eq: $chainId }
      _or: [
        { _and: [{ tokenIn: { _in: $base } }, { tokenOut: { _in: $quote } }] }
        { _and: [{ tokenIn: { _in: $quote } }, { tokenOut: { _in: $base } }] }
      ]
    }
    order_by: [{ blockTimestamp: desc }, { logIndex: desc }]
    limit: $limit
    offset: $offset
  ) {
    id
    chainId
    txHash
    logIndex
    blockTimestamp
    maker
    taker
    tokenIn
    tokenOut
    amountIn
    amountOut
    feeAmount
    makerDigest
    takerDigest
  }
}`

/** 索引器源取数超时（第 39 轮）：Envio GraphQL 跨公网且有冷查询，宽放至 8 秒 */
export const INDEXER_TRADES_TIMEOUT_MS = 8000

/** 取数器：接收超时控制器信号，须把 signal 真传进底层 fetch */
export type SourceFetcher<T> = (signal: AbortSignal) => Promise<T>

/**
 * 第 39 轮：带真取消的超时调用。第 35 轮 D6 的 allSettled 只能隔离
 * reject——请求永不返回（挂死）时永不落定。本函数以平台标准
 * AbortController 在超时时真 abort 底层 fetch（连接随之释放），同时
 * 以竞速兜底：即使对端 promise 不理会 signal，也准时判失败。
 */
async function callWithTimeout<T>(
  timeoutMs: number,
  label: string,
  run: SourceFetcher<T>,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`${label} timeout after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([run(controller.signal), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export interface IndexerTradesOutcome {
  trades: DisplayTrade[]
  /** 本轮索引取数失败（界面须明示不可用，而非「暂无成交」） */
  failed: boolean
}

export interface LoadIndexerOptions {
  timeoutMs?: number
  fetchFn?: FetchFn
  endpoint?: string
}

/**
 * 成交记录单源读取（第 51 轮）：拉索引 → 换算展示值。索引未配置
 * （endpoint 为空）或交易对未知 → failed=true、无数据；取数抛错/超时
 * 同样 failed=true——调用方据此显示「暂不可用」，不冒充空成交。
 */
export async function loadIndexerTrades(
  chainId: number,
  pair: string,
  limit = 50,
  opts: LoadIndexerOptions = {},
): Promise<IndexerTradesOutcome> {
  const endpoint = opts.endpoint ?? INDEXER_URL
  const tokens = getPairTokens(chainId, pair)
  if (!endpoint || !tokens) return { trades: [], failed: true }
  try {
    const rows = await callWithTimeout(
      opts.timeoutMs ?? INDEXER_TRADES_TIMEOUT_MS,
      'indexer trades',
      (signal) =>
        fetchIndexerTrades(chainId, pair, limit, opts.fetchFn, endpoint, 0, { signal }),
    )
    return { trades: rows.map((t) => indexerTradeToDisplay(t, tokens.base)), failed: false }
  } catch {
    return { trades: [], failed: true }
  }
}

export interface TradesQueryVariables {
  chainId: number
  limit: number
  offset: number
  /** base 代币地址的大小写变体集合（配置原样 + 小写） */
  base: string[]
  /** quote 代币地址的大小写变体集合 */
  quote: string[]
}

const caseVariants = (addr: string): string[] => [...new Set([addr, addr.toLowerCase()])]

/** 构造按对过滤的查询变量（纯函数，可单测） */
export function buildTradesQueryVariables(
  chainId: number,
  baseToken: string,
  quoteToken: string,
  limit: number,
  offset: number,
): TradesQueryVariables {
  return {
    chainId,
    limit,
    offset,
    base: caseVariants(baseToken),
    quote: caseVariants(quoteToken),
  }
}

/**
 * 索引器取数函数契约（第 40 轮，第 39 轮复审 F2）：注入的 FetchFn 必须
 * 遵守 init.signal——信号取消后应尽快 reject。fetchIndexerTrades 的直
 * 调路径只靠 signal 取消、不另设竞速兜底；竞速兜底只在 loadIndexerTrades
 * 的 callWithTimeout 一层（两者分工，不重复造轮子）。
 */
export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

const defaultFetch: FetchFn = async (url, init) => {
  const res = await fetch(url, init)
  return { ok: res.ok, status: res.status, json: () => res.json() }
}

export interface FetchIndexerOptions {
  /**
   * 外部取消信号（由 loadIndexerTrades 的超时控制器传入）；传入时
   * 以外部信号为准，本函数不再另设计时。
   */
  signal?: AbortSignal
  /** 未传 signal 时的内部超时（毫秒），默认 INDEXER_TRADES_TIMEOUT_MS；主要供测试注入小值 */
  timeoutMs?: number
}

/**
 * 拉取 Envio 成交：交易对过滤以 GraphQL where 服务端过滤为主（第 35 轮
 * D5），返回后再做一层客户端精确集合校验作兜底（索引实体只有代币地址、
 * 无 pair 符号；无序集合比对，两个方向都算本对成交）。
 *
 * 第 39 轮：① 取数超时真取消——单源路径用外部 signal，直接调用时自建
 * AbortController 按 INDEXER_TRADES_TIMEOUT_MS 兜底，signal 真传进
 * fetch；② GraphQL 在 HTTP 200 下仍可带 errors（执行/部分失败），非空
 * errors 视为索引源失败抛错，走既有降级路径，不当成「成功查到 0 笔」。
 */
export async function fetchIndexerTrades(
  chainId: number,
  pair: string,
  limit = 50,
  fetchFn: FetchFn = defaultFetch,
  endpoint: string = INDEXER_URL,
  offset = 0,
  options: FetchIndexerOptions = {},
): Promise<IndexerTrade[]> {
  if (!endpoint) return []
  const tokens = getPairTokens(chainId, pair)
  if (!tokens) return []
  const ownController = options.signal ? null : new AbortController()
  const signal = options.signal ?? ownController!.signal
  const timer = ownController
    ? setTimeout(
        () => ownController.abort(),
        options.timeoutMs ?? INDEXER_TRADES_TIMEOUT_MS,
      )
    : undefined
  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: TRADES_QUERY,
        variables: buildTradesQueryVariables(chainId, tokens.base, tokens.quote, limit, offset),
      }),
      signal,
    })
    if (!res.ok) throw new Error(`indexer http ${res.status}`)
    const json = (await res.json()) as { data?: { Trade?: unknown[] }; errors?: unknown[] }
    if (Array.isArray(json?.errors) && json.errors.length > 0) {
      throw new Error('indexer graphql query failed')
    }
    const rows = Array.isArray(json?.data?.Trade) ? json.data!.Trade : []
    const pairSet = new Set([lc(tokens.base), lc(tokens.quote)])
    return rows
      .map((r) => {
        const o = r as Record<string, unknown>
        return {
          id: String(o.id ?? ''),
          chainId: Number(o.chainId ?? chainId),
          txHash: String(o.txHash ?? ''),
          logIndex: Number(o.logIndex ?? 0),
          blockTimestamp: Number(o.blockTimestamp ?? 0),
          maker: String(o.maker ?? ''),
          taker: String(o.taker ?? ''),
          tokenIn: String(o.tokenIn ?? ''),
          tokenOut: String(o.tokenOut ?? ''),
          amountIn: String(o.amountIn ?? '0'),
          amountOut: String(o.amountOut ?? '0'),
          feeAmount: String(o.feeAmount ?? '0'),
          makerDigest: (o.makerDigest as string | null) ?? null,
          takerDigest: (o.takerDigest as string | null) ?? null,
        } satisfies IndexerTrade
      })
      .filter(
        (t) =>
          pairSet.has(lc(t.tokenIn)) &&
          pairSet.has(lc(t.tokenOut)) &&
          lc(t.tokenIn) !== lc(t.tokenOut),
      )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
