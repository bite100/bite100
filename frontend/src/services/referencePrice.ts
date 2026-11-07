/**
 * 参考价层（第二十三轮，设计见 docs/round23-oracle-reference-price-2026-11-07.md）：
 * 给下单面板一个「可信、标注来源、带数据时间」的参考价，帮助用户报价时心里有数。
 *
 * 来源优先级（诚实口径，绝不伪造）：
 * 1. 交易对在链配置里有 Chainlink 喂价 → 直读 AggregatorV3 latestRoundData，
 *    并做时效/有效性校验；过期就是过期（status=stale），不用自家数据冒充新鲜预言机价，
 *    也不拿旧价装新价。当前只有真实资产对 ETH/USD 两条测试网配了喂价。
 * 2. 无喂价的交易对（如 TKA/TKB，世界上不存在它们的外部报价）→ 本所最近成交价；
 * 3. 无成交 → 盘口中间价（买一/卖一两边都有才算）；
 * 4. 都没有 → status=none，面板明说「新市场，暂无参考价」。
 *
 * 参考价只是报价参考，不参与签名、撮合与结算，偏离它下单只警告不拦截。
 */
import { Contract, JsonRpcProvider } from 'ethers'
import { getChainConfig } from '../config/chains'
import type { MarketBookLevel } from '../components/dashboard/marketOrder'

export const AGGREGATOR_V3_ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
] as const

/**
 * 时效阈值 = 心跳 × 3，且不低于 1 小时。
 * 理由（2026-11-07 两条测试网实测）：Sepolia ETH/USD 更新间隔约 3636s、Base Sepolia
 * 约 1000–1220s，与官方心跳 3600s/1200s 吻合，说明测试网喂价基本靠心跳驱动、
 * 偏差触发很少。取 3 倍心跳可容忍一整轮漏传/延迟而不误杀正常喂价；同时喂价若真
 * 停摆，年龄无限增长，3 倍心跳后仍能判过期。参考价仅供报价参考（非清算价），
 * 且面板同时展示数据时间，用户对新鲜度有直接感知。
 */
export const STALE_HEARTBEAT_MULTIPLIER = 3
export const MIN_STALE_AFTER_SEC = 3600

/** 填写价格偏离参考价超过该百分比时给出醒目警告（只警告，不拦截下单） */
export const DEVIATION_WARN_PCT = 10

export type ReferencePriceSource = 'chainlink' | 'lastTrade' | 'bookMid'

export interface ReferencePrice {
  /** 参考价（quote/base，人类单位） */
  price: number
  source: ReferencePriceSource
  /** 数据产生时间（unix 秒）：预言机=updatedAt、最近成交=成交时间、盘口中间价=取盘口时刻 */
  updatedAtSec: number
}

export type ReferencePriceResult =
  | { status: 'ok'; ref: ReferencePrice }
  /** 有喂价但数据已过期：面板明说不可用，不降级冒充 */
  | { status: 'stale'; updatedAtSec: number }
  /** 有喂价但读取失败或数据非法（零/负价等） */
  | { status: 'error' }
  /** 无喂价且无任何自家市场数据 */
  | { status: 'none' }

export const REFERENCE_SOURCE_LABELS: Record<ReferencePriceSource, string> = {
  chainlink: 'Chainlink 预言机',
  lastTrade: '本所最近成交',
  bookMid: '盘口中间价',
}

export interface FeedConfig {
  address: string
  heartbeatSec: number
}

/** 取某链某交易对的 Chainlink 喂价配置；无配置返回 null（该对走自家数据兜底） */
export function getFeedConfig(chainId: number, pair: string): FeedConfig | null {
  const cfg = getChainConfig(chainId)
  const feed = cfg?.chainlinkFeeds?.[pair]
  if (!feed) return null
  return { address: feed.address, heartbeatSec: feed.heartbeatSec }
}

/** 由心跳推导时效阈值（秒）；心跳非法时直接用下限 */
export function staleAfterSec(heartbeatSec: number): number {
  if (!Number.isFinite(heartbeatSec) || heartbeatSec <= 0) return MIN_STALE_AFTER_SEC
  return Math.max(MIN_STALE_AFTER_SEC, heartbeatSec * STALE_HEARTBEAT_MULTIPLIER)
}

export interface FeedReading {
  /** latestRoundData 的原始 answer（按 feed decimals 定点） */
  answer: bigint
  decimals: number
  updatedAtSec: number
}

export type FeedEvaluation =
  | { kind: 'ok'; price: number }
  | { kind: 'stale'; updatedAtSec: number }
  | { kind: 'invalid' }

/**
 * 校验一笔喂价读数：零/负价、decimals 异常、updatedAt 缺失都判 invalid；
 * 年龄超过时效阈值判 stale；其余换算为人类单位价格。
 * 注意：updatedAt 晚于本地时间（时钟偏差）时年龄按 0 处理，不误杀。
 */
export function evaluateFeedReading(
  reading: FeedReading,
  nowSec: number,
  heartbeatSec: number
): FeedEvaluation {
  const { answer, decimals, updatedAtSec } = reading
  if (answer <= 0n) return { kind: 'invalid' }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return { kind: 'invalid' }
  if (!Number.isFinite(updatedAtSec) || updatedAtSec <= 0) return { kind: 'invalid' }
  const age = Math.max(0, nowSec - updatedAtSec)
  if (age > staleAfterSec(heartbeatSec)) return { kind: 'stale', updatedAtSec }
  const price = Number(answer) / 10 ** decimals
  if (!Number.isFinite(price) || price <= 0) return { kind: 'invalid' }
  return { kind: 'ok', price }
}

/** 盘口中间价：买一与卖一两边都有有效报价才算，否则 null（单边盘口不编中间价） */
export function bookMidPrice(
  bids: MarketBookLevel[] | undefined,
  asks: MarketBookLevel[] | undefined
): number | null {
  const valid = (levels: MarketBookLevel[] | undefined, pickMax: boolean): number | null => {
    let best: number | null = null
    for (const l of levels ?? []) {
      const p = parseFloat(l.price)
      if (!Number.isFinite(p) || p <= 0) continue
      if (best == null || (pickMax ? p > best : p < best)) best = p
    }
    return best
  }
  const bid = valid(bids, true)
  const ask = valid(asks, false)
  if (bid == null || ask == null) return null
  return (bid + ask) / 2
}

/** 偏离百分比（带符号：正=高于参考价，负=低于参考价）；任一价无效返回 null */
export function deviationPct(inputPrice: number, referencePrice: number): number | null {
  if (!Number.isFinite(inputPrice) || !Number.isFinite(referencePrice)) return null
  if (inputPrice <= 0 || referencePrice <= 0) return null
  return ((inputPrice - referencePrice) / referencePrice) * 100
}

/** 是否触发偏离警告：|偏离| 严格超过阈值才触发（恰好 10% 不触发） */
export function isDeviationWarning(
  inputPrice: number,
  referencePrice: number,
  thresholdPct: number = DEVIATION_WARN_PCT
): boolean {
  const d = deviationPct(inputPrice, referencePrice)
  return d != null && Math.abs(d) > thresholdPct
}

export interface MarketFallback {
  /** 本所最近成交价（节点 /api/trades 推导）；无成交为 null */
  lastTradePrice: number | null
  /** 最近成交时间（unix 秒）；未知为 null（此时以当前时间标注，仅影响展示） */
  lastTradeAtSec: number | null
  bids?: MarketBookLevel[]
  asks?: MarketBookLevel[]
}

/** 无喂价交易对的兜底解析：最近成交价 → 盘口中间价 → 无 */
export function resolveMarketReference(
  fallback: MarketFallback,
  nowSec: number
): ReferencePriceResult {
  const lt = fallback.lastTradePrice
  if (lt != null && Number.isFinite(lt) && lt > 0) {
    return {
      status: 'ok',
      ref: {
        price: lt,
        source: 'lastTrade',
        updatedAtSec: fallback.lastTradeAtSec && fallback.lastTradeAtSec > 0 ? fallback.lastTradeAtSec : nowSec,
      },
    }
  }
  const mid = bookMidPrice(fallback.bids, fallback.asks)
  if (mid != null) {
    return { status: 'ok', ref: { price: mid, source: 'bookMid', updatedAtSec: nowSec } }
  }
  return { status: 'none' }
}

export interface ReferencePriceDeps {
  /** 读一笔喂价（默认实现走链配置的公开 RPC 直读）；注入点便于测试 */
  readFeed: (chainId: number, address: string) => Promise<FeedReading>
  nowSec: () => number
}

/** 默认喂价读取：ethers JsonRpcProvider 直连该链公开 RPC 读 AggregatorV3 代理 */
export async function readChainlinkFeed(chainId: number, address: string): Promise<FeedReading> {
  const cfg = getChainConfig(chainId)
  if (!cfg) throw new Error(`未知链 ${chainId}`)
  const provider = new JsonRpcProvider(cfg.rpcUrl)
  const feed = new Contract(address, AGGREGATOR_V3_ABI, provider)
  const [round, decimals] = await Promise.all([feed.latestRoundData(), feed.decimals()])
  return {
    answer: BigInt(round.answer),
    decimals: Number(decimals),
    updatedAtSec: Number(round.updatedAt),
  }
}

export const defaultReferencePriceDeps: ReferencePriceDeps = {
  readFeed: readChainlinkFeed,
  nowSec: () => Math.floor(Date.now() / 1000),
}

/**
 * 参考价解析总入口（优先级见文件头）：
 * - 有喂价：只认预言机结果——新鲜=ok、过期=stale、读失败/非法=error，不降级兜底冒充；
 * - 无喂价：走 resolveMarketReference 的自家数据兜底。
 */
export async function resolveReferencePrice(
  chainId: number,
  pair: string,
  fallback: MarketFallback,
  deps: ReferencePriceDeps = defaultReferencePriceDeps
): Promise<ReferencePriceResult> {
  const feed = getFeedConfig(chainId, pair)
  if (!feed) return resolveMarketReference(fallback, deps.nowSec())
  let reading: FeedReading
  try {
    reading = await deps.readFeed(chainId, feed.address)
  } catch {
    return { status: 'error' }
  }
  const ev = evaluateFeedReading(reading, deps.nowSec(), feed.heartbeatSec)
  if (ev.kind === 'ok') {
    return {
      status: 'ok',
      ref: { price: ev.price, source: 'chainlink', updatedAtSec: reading.updatedAtSec },
    }
  }
  if (ev.kind === 'stale') return { status: 'stale', updatedAtSec: ev.updatedAtSec }
  return { status: 'error' }
}
