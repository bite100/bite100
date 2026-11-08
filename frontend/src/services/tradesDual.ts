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

const TRADES_QUERY = `
query Bit100Trades($chainId: Int!, $limit: Int!) {
  Trade(
    where: { chainId: { _eq: $chainId } }
    order_by: { blockTimestamp: desc }
    limit: $limit
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

export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

const defaultFetch: FetchFn = async (url, init) => {
  const res = await fetch(url, init)
  return { ok: res.ok, status: res.status, json: () => res.json() }
}

/**
 * 拉取 Envio 成交（按当前交易对的代币集合过滤——索引实体只有代币地址，
 * 无 pair 符号；无序集合比对，两个方向都算本对成交）。
 */
export async function fetchIndexerTrades(
  chainId: number,
  pair: string,
  limit = 50,
  fetchFn: FetchFn = defaultFetch,
  endpoint: string = INDEXER_URL,
): Promise<IndexerTrade[]> {
  if (!endpoint) return []
  const tokens = getPairTokens(chainId, pair)
  if (!tokens) return []
  const res = await fetchFn(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: TRADES_QUERY, variables: { chainId, limit } }),
  })
  if (!res.ok) throw new Error(`indexer http ${res.status}`)
  const json = (await res.json()) as { data?: { Trade?: unknown[] } }
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
}
