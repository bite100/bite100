/**
 * 第 34 轮（无节点阶段 2C）成交记录双源合并。
 *
 * 口径（简报定稿）：
 * - 节点 API 成交为过渡源保留；配置 VITE_INDEXER_URL 后 Envio 为权威展示源。
 * - 去重键 = (chainId, txHash, logIndex)。节点成交不带 logIndex，因此同 tx
 *   内的配对规则：先按 (maker, taker, amountIn, amountOut) 多重集精确匹配；
 *   同 tx 同双方但数量对不上的节点行判为冲突，链上事件为准、节点行抑制；
 *   其余节点独有行标「待索引」（pendingIndex，含尚未上链、无 txHash 的行）。
 * - Envio 独有行照常展示（节点漏记/未同步时以链上为准）。
 */
import { INDEXER_URL } from '../config/indexer'
import { getPairTokens } from '../config/pairs'

/** 节点 /api/trades 归一化行（保留合并所需字段） */
export interface NodeTrade {
  tradeId: string
  txHash: string
  maker: string
  taker: string
  tokenIn: string
  tokenOut: string
  amountIn: string
  amountOut: string
  /** 1e18 定点整数字符串（节点口径） */
  price: string
  amount: string
  timestamp: number
}

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

export type MergedTradeSource = 'envio' | 'node' | 'both'

export interface MergedTrade {
  /** 展示键：优先链上身份 (chainId-txHash-logIndex)，节点独有行用节点 tradeId */
  key: string
  source: MergedTradeSource
  /** 节点独有（Envio 尚未索引/尚未上链） */
  pendingIndex: boolean
  price: number
  amount: number
  timestamp: number
  txHash: string
  logIndex: number | null
}

export interface MergeResult {
  trades: MergedTrade[]
  /** 同 tx 同双方但数量不一致、按链上为准抑制了节点行的数量 */
  conflicts: number
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

/** 价格/数量展示换算：与节点口径对齐（price 为计价/基础，amount 为基础币数量） */
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

function matchKey(t: { maker: string; taker: string; amountIn: string; amountOut: string }): string {
  const norm = (v: string) => {
    try {
      return BigInt(v).toString()
    } catch {
      return v
    }
  }
  return `${lc(t.maker)}|${lc(t.taker)}|${norm(t.amountIn)}|${norm(t.amountOut)}`
}

/** 双源合并（纯函数，可单测） */
export function mergeTradeSources(
  nodeTrades: NodeTrade[],
  indexerTrades: IndexerTrade[],
  baseToken: string,
): MergeResult {
  const byTx = new Map<string, IndexerTrade[]>()
  for (const t of indexerTrades) {
    const k = lc(t.txHash)
    const arr = byTx.get(k) ?? []
    arr.push(t)
    byTx.set(k, arr)
  }
  const usedIndexer = new Set<string>()
  const out: MergedTrade[] = []
  let conflicts = 0

  const toMerged = (
    t: IndexerTrade,
    source: MergedTradeSource,
  ): MergedTrade => {
    const { price, amount } = displayValues(t.tokenIn, t.amountIn, t.amountOut, baseToken)
    return {
      key: t.id,
      source,
      pendingIndex: false,
      price,
      amount,
      timestamp: t.blockTimestamp,
      txHash: t.txHash,
      logIndex: t.logIndex,
    }
  }

  for (const n of nodeTrades) {
    const candidates = n.txHash ? (byTx.get(lc(n.txHash)) ?? []) : []
    const exact = candidates.find(
      (c) => !usedIndexer.has(c.id) && matchKey(c) === matchKey(n),
    )
    if (exact) {
      usedIndexer.add(exact.id)
      out.push(toMerged(exact, 'both'))
      continue
    }
    // 同 tx、同双方、数量对不上 → 冲突，以链上事件为准，抑制节点行
    const conflicted = candidates.some(
      (c) =>
        !usedIndexer.has(c.id) &&
        lc(c.maker) === lc(n.maker) &&
        lc(c.taker) === lc(n.taker),
    )
    if (conflicted && n.txHash) {
      conflicts += 1
      continue
    }
    const price = scaledToNumber(n.price)
    out.push({
      key: n.tradeId || `node-${n.txHash}-${n.timestamp}`,
      source: 'node',
      pendingIndex: true,
      price,
      amount: scaledToNumber(n.amount),
      timestamp: n.timestamp,
      txHash: n.txHash,
      logIndex: null,
    })
  }
  for (const t of indexerTrades) {
    if (!usedIndexer.has(t.id)) out.push(toMerged(t, 'envio'))
  }
  out.sort((a, b) => b.timestamp - a.timestamp || (b.logIndex ?? -1) - (a.logIndex ?? -1))
  return { trades: out, conflicts }
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
 * 同块多笔成交时分页边界确定，与客户端 merge 的 (timestamp, logIndex)
 * 排序口径对齐。
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

/**
 * 节点 /api/trades 原始行 → NodeTrade 归一化（第 39 轮抽为共用）：
 * 「最新成交」（RecentTradesWidget）与桌面「成交记录」页签
 * （TradeTabsPanel）走同一条双源路径、共用同一映射，避免两处口径漂移。
 */
export function normalizeNodeTradeRow(t: unknown): NodeTrade {
  const o: Record<string, unknown> =
    t && typeof t === 'object' ? (t as Record<string, unknown>) : {}
  return {
    tradeId: String(o.tradeId ?? o.TradeID ?? ''),
    txHash: String(o.txHash ?? ''),
    maker: String(o.maker ?? ''),
    taker: String(o.taker ?? ''),
    tokenIn: String(o.tokenIn ?? ''),
    tokenOut: String(o.tokenOut ?? ''),
    amountIn: String(o.amountIn ?? '0'),
    amountOut: String(o.amountOut ?? '0'),
    price: String(o.price ?? '0'),
    amount: String(o.amount ?? '0'),
    timestamp: Number(o.timestamp ?? 0),
  }
}

/** 节点源取数超时（第 39 轮）：节点在本机/隧道近端，5 秒足够判活 */
export const NODE_TRADES_TIMEOUT_MS = 5000
/** 索引器源取数超时（第 39 轮）：Envio GraphQL 跨公网且有冷查询，宽放至 8 秒 */
export const INDEXER_TRADES_TIMEOUT_MS = 8000

/** 双源取数器：接收超时控制器信号，须把 signal 真传进底层 fetch */
export type SourceFetcher<T> = (signal: AbortSignal) => Promise<T>

export interface DualTradesTimeouts {
  nodeTimeoutMs?: number
  indexerTimeoutMs?: number
}

/**
 * 第 39 轮：带真取消的超时调用。第 35 轮 D6 的 allSettled 只能隔离
 * reject——请求永不返回（挂死）时 allSettled 永不落定，健康源已取到的
 * 数据也被拖住不展示。本函数以平台标准 AbortController 在超时时真
 * abort 底层 fetch（连接随之释放），同时以竞速兜底：即使对端 promise
 * 不理会 signal，也准时判该源失败。
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

export interface DualTradesOutcome {
  result: MergeResult
  /** 节点源本轮失败（Envio 数据不受影响，照常展示） */
  nodeFailed: boolean
  /** 索引源本轮失败（节点独有行全部标「待索引」展示） */
  indexerFailed: boolean
  /** 两源皆失败 → 无数据可用，界面须明示不可用而非「暂无成交」 */
  unavailable: boolean
}

/**
 * 第 35 轮 D6：两源独立取数、独立失败。旧实现先 await 节点、外层 catch
 * 一把清——节点宕机时 Envio 明明有数据也被整页盖掉，与「配置索引后以
 * 索引为权威」矛盾。本函数以 allSettled 并发取两源：任一源失败只降级
 * 该源（失败标记随结果返回供界面明示），合并口径仍走 mergeTradeSources。
 *
 * 第 39 轮：两源各加取数超时（callWithTimeout，默认节点 5 秒 / 索引器
 * 8 秒，可注入更小值供测试）——超时按该源失败降级，语义与 D6 一致；
 * 任一源被拖死不再连累另一源的展示。
 */
export async function loadDualTrades(
  fetchNode: SourceFetcher<NodeTrade[]>,
  fetchIndexer: SourceFetcher<IndexerTrade[]>,
  baseToken: string,
  timeouts: DualTradesTimeouts = {},
): Promise<DualTradesOutcome> {
  const [n, i] = await Promise.allSettled([
    callWithTimeout(timeouts.nodeTimeoutMs ?? NODE_TRADES_TIMEOUT_MS, 'node trades', fetchNode),
    callWithTimeout(
      timeouts.indexerTimeoutMs ?? INDEXER_TRADES_TIMEOUT_MS,
      'indexer trades',
      fetchIndexer,
    ),
  ])
  const nodeFailed = n.status === 'rejected'
  const indexerFailed = i.status === 'rejected'
  return {
    result: mergeTradeSources(
      nodeFailed ? [] : (n as PromiseFulfilledResult<NodeTrade[]>).value,
      indexerFailed ? [] : (i as PromiseFulfilledResult<IndexerTrade[]>).value,
      baseToken,
    ),
    nodeFailed,
    indexerFailed,
    unavailable: nodeFailed && indexerFailed,
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
 * 调路径只靠 signal 取消、不另设竞速兜底；竞速兜底只在 loadDualTrades
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
   * 外部取消信号（双源路径由 loadDualTrades 的超时控制器传入）；传入时
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
 * 第 39 轮：① 取数超时真取消——双源路径用外部 signal，直接调用时自建
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
