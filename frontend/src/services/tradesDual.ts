/**
 * 成交记录读取：第 34 轮建立时为「节点 API + Envio 索引」双源合并；
 * 第 51 轮（无节点阶段 5 节点退役）改为链上索引单源。
 *
 * 口径（Ren 2026-11-09 定版）：链是唯一账本，索引（Envio）只是网页的
 * 展示缓存——成交记录直接读索引的链上 Trade 事件，不再与节点记录做
 * 去重/冲突合并（节点的成交记录随节点下线一并退役）。索引不可达时
 * 界面如实显示「暂不可用」，绝不拿空数据冒充「暂无成交」。
 *
 * 第 52 轮 A3 补两处诚实性：① GraphQL 响应无 data 且无 errors（或
 * data.Trade 缺失）按索引源失败抛错，不再以空数组冒充「查到 0 笔」；
 * ② 索引滞后标注：并行查 _meta 进度，outcome.stale 只作展示标注
 * （未就绪或落后 >50 块），绝不阻断、不并入 failed。
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
  /**
   * 索引滞后标注（第 52 轮 A3）：该链索引未就绪（isReady 明确为
   * false）或落后链头超过 INDEXER_STALE_LAG_BLOCKS 块时为 true。
   * 口径（Ren 定版）：索引只是展示缓存——滞后只标注、绝不阻断、
   * 不影响 failed；滞后判不出（_meta 查询失败）时为 false，不拿
   * 不确定当滞后喊。第 53 轮补：isReady 字段缺失同属「判不出」，
   * 不得据此标 stale（只有明确 false 才算未就绪）。
   */
  stale: boolean
}

/** 索引滞后阈值（块）：落后链头超过此数即标 stale（第 52 轮 A3） */
export const INDEXER_STALE_LAG_BLOCKS = 50

/** Envio 索引进度查询：_meta 是跨链列表（实测字段），客户端按 chainId 挑行 */
export const INDEXER_META_QUERY = `
query Bit100IndexerMeta {
  _meta {
    chainId
    progressBlock
    sourceBlock
    isReady
  }
}`

export interface IndexerChainProgress {
  /** 落后链头的块数（sourceBlock − progressBlock，下限 0） */
  lagBlocks: number
  /**
   * 索引就绪三态（第 53 轮，修第 52 轮复审 P2）：true / false 只认
   * _meta 行里明确的布尔值；字段缺失或非布尔 → null（无证据）。
   * 此前 `row.isReady === true` 把「缺失」压成 false，stale 公式
   * 再据此误标滞后——与本文件「标注只凭实证」口径自相矛盾。
   */
  isReady: boolean | null
}

/**
 * 查 Envio 某链的索引进度（第 52 轮 A3）：骑与成交查询同一条
 * fetch 路径，不引入第二套 GraphQL 客户端。任何失败/进度字段
 * 缺失/找不到该链的行 → 返回 null（滞后判不出），由调用方按
 * 「不标 stale」处理——标注只凭实证，不凭猜测。第 53 轮起
 * isReady 单独三态：缺失只让 isReady=null，不拖垮块差证据。
 */
export async function fetchIndexerChainProgress(
  chainId: number,
  fetchFn: FetchFn = defaultFetch,
  endpoint: string = INDEXER_URL,
  signal?: AbortSignal,
): Promise<IndexerChainProgress | null> {
  if (!endpoint) return null
  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: INDEXER_META_QUERY }),
      signal,
    })
    if (!res.ok) return null
    const json = (await res.json()) as { data?: { _meta?: unknown } } | null
    const meta = json?.data?._meta
    const rows: unknown[] = Array.isArray(meta) ? meta : meta ? [meta] : []
    const row = rows.find(
      (r) =>
        r !== null &&
        typeof r === 'object' &&
        Number((r as Record<string, unknown>).chainId) === chainId,
    ) as Record<string, unknown> | undefined
    if (!row) return null
    const progressBlock = Number(row.progressBlock)
    const sourceBlock = Number(row.sourceBlock)
    if (!Number.isFinite(progressBlock) || !Number.isFinite(sourceBlock)) return null
    return {
      lagBlocks: Math.max(0, sourceBlock - progressBlock),
      isReady: typeof row.isReady === 'boolean' ? row.isReady : null,
    }
  } catch {
    return null
  }
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
  if (!endpoint || !tokens) return { trades: [], failed: true, stale: false }
  try {
    // 成交查询与索引进度查询并行、同受本层超时约束；进度查询失败
    // 只意味着滞后判不出（stale=false），不拖垮成交数据本身。
    const { rows, progress } = await callWithTimeout(
      opts.timeoutMs ?? INDEXER_TRADES_TIMEOUT_MS,
      'indexer trades',
      async (signal) => {
        const [tradeRows, chainProgress] = await Promise.all([
          fetchIndexerTrades(chainId, pair, limit, opts.fetchFn, endpoint, 0, { signal }),
          fetchIndexerChainProgress(chainId, opts.fetchFn, endpoint, signal),
        ])
        return { rows: tradeRows, progress: chainProgress }
      },
    )
    const stale =
      progress !== null &&
      (progress.isReady === false || progress.lagBlocks > INDEXER_STALE_LAG_BLOCKS)
    return {
      trades: rows.map((t) => indexerTradeToDisplay(t, tokens.base)),
      failed: false,
      stale,
    }
  } catch {
    return { trades: [], failed: true, stale: false }
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
    // 第 52 轮 A3：GraphQL 响应必须至少带 data 或 errors——两者皆无
    // （或 data 在但 Trade 字段缺失/非数组）是异常响应，旧实现以 []
    // 兜底会被上层当成「查到 0 笔成交」展示成暂无成交。现按索引源
    // 失败抛错，走既有 failed 口径。data.Trade 为空数组才是真空。
    const tradeField = json?.data?.Trade
    if (!Array.isArray(tradeField)) {
      throw new Error('indexer graphql response missing data.Trade')
    }
    const rows = tradeField
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
