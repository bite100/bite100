/**
 * 交易对登记（第二十五轮，主流交易对上架）：
 * 8 个交易对——7 个主流币对 USDT + 原有的 TKA/TKB；默认 BTC/USDT。
 * 每个交易对的基础/计价代币地址取自当链 chains.ts 的 tokens 登记（第二十五轮部署的
 * MockERC20，18 位；TKA/TKB 沿用原 token0/token1 地址）。未登记的交易对不接受下单，
 * 前端不凭空编造代币地址。
 */
import { getChainConfig } from './chains'

export const TRADE_PAIRS = [
  'BTC/USDT',
  'ETH/USDT',
  'SOL/USDT',
  'BNB/USDT',
  'XRP/USDT',
  'DOGE/USDT',
  'LINK/USDT',
  'TKA/TKB',
] as const

export type TradePair = (typeof TRADE_PAIRS)[number]

/** 默认交易对：BTC/USDT（第二十五轮任务指定） */
export const DEFAULT_PAIR: TradePair = 'BTC/USDT'

export function isTradePair(pair: string): pair is TradePair {
  return (TRADE_PAIRS as readonly string[]).includes(pair)
}

/** 从 URL 查询串解析交易对：?pair=BTC/USDT；非法/缺失时回默认对 */
export function pairFromSearch(search: string): TradePair {
  try {
    const p = new URLSearchParams(search).get('pair')
    if (p && isTradePair(p)) return p
  } catch {
    // URLSearchParams 异常时回默认对，不阻塞页面
  }
  return DEFAULT_PAIR
}

export interface PairTokens {
  /** 基础币（base，如 BTC）合约地址 */
  base: string
  /** 计价币（quote，如 USDT）合约地址 */
  quote: string
}

/**
 * 取某链某交易对的代币地址；任一符号未登记返回 null（调用方据此拒绝下单并明示，
 * 不用 TKA/TKB 的地址冒充）。
 */
export function getPairTokens(chainId: number, pair: string): PairTokens | null {
  const cfg = getChainConfig(chainId)
  if (!cfg) return null
  const [baseSym, quoteSym] = pair.split('/')
  if (!baseSym || !quoteSym) return null
  const base = cfg.tokens?.[baseSym]
  const quote = cfg.tokens?.[quoteSym]
  if (!base || !quote) return null
  return { base, quote }
}
