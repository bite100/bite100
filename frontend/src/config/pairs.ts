/**
 * 交易对登记（第二十五轮，主流交易对上架）：
 * 8 个交易对——7 个主流币对 USDT + 原有的 TKA/TKB；默认 BTC/USDT。
 * 每个交易对的基础/计价代币地址取自当链 chains.ts 的 tokens 登记（第二十五轮部署的
 * MockERC20，18 位；TKA/TKB 沿用原 token0/token1 地址）。未登记的交易对不接受下单，
 * 前端不凭空编造代币地址。
 */
import { getChainConfig } from './chains'
import {
  SEED_TOKEN_DECIMALS,
  getCachedListedPair,
  parsePairKey,
} from '../services/pairRegistry'

const SEED_DECIMALS = SEED_TOKEN_DECIMALS

function parseListedKey(pair: string) {
  return parsePairKey(pair)
}

function listedPairCacheLookup(chainId: number, pair: string) {
  const row = getCachedListedPair(chainId, pair)
  if (!row) return null
  return {
    baseToken: row.base.address,
    quoteToken: row.quote.address,
    baseDecimals: row.base.decimals,
    quoteDecimals: row.quote.decimals,
  }
}

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

/**
 * 从 URL 查询串解析任意交易对（第六十轮）：种子符号键，或链号与当前链一致的
 * 自助上架地址型键；其余回默认对。地址型键只校验格式与链号——是否已在
 * 注册表登记由解析层（pairRegistry）在运行时判定，未登记时下单被禁用。
 */
export function pairFromSearchAny(search: string, chainId: number): string {
  try {
    const p = new URLSearchParams(search).get('pair')
    if (p && isTradePair(p)) return p
    if (p) {
      const key = parsePairKey(p)
      if (key && key.chainId === chainId) return p
    }
  } catch {
    // 同 pairFromSearch：异常回默认对
  }
  return DEFAULT_PAIR
}

/** 是否可作为当前链的当前交易对：种子键，或链号匹配的自助上架地址型键 */
export function isSelectablePair(pair: string, chainId: number): boolean {
  if (isTradePair(pair)) return true
  const key = parsePairKey(pair)
  return key !== null && key.chainId === chainId
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
 *
 * 第六十轮：种子对查不到时再查自助上架注册表缓存（地址型键
 * `<chainId>:<base>/<quote>`，services/pairRegistry）——注册表未拉取/未命中
 * 仍返回 null，与旧行为一致，不凭空编造地址。
 */
export function getPairTokens(chainId: number, pair: string): PairTokens | null {
  const cfg = getChainConfig(chainId)
  if (!cfg) return null
  const [baseSym, quoteSym] = pair.split('/')
  if (!baseSym || !quoteSym) return null
  const base = cfg.tokens?.[baseSym]
  const quote = cfg.tokens?.[quoteSym]
  if (base && quote) return { base, quote }
  const listed = getListedPairTokens(chainId, pair)
  return listed
}

/**
 * 自助上架对的代币地址（查 pairRegistry 缓存）。单独成函数并动态引用缓存
 * 读取，避免 config 层与 services 层的静态循环依赖（pairRegistry 不 import 本文件，
 * 此处静态 import 亦安全，但缓存读取函数保持在调用点解析）。
 */
function getListedPairTokens(chainId: number, pair: string): PairTokens | null {
  const key = parseListedKey(pair)
  if (!key || key.chainId !== chainId) return null
  const row = listedPairCacheLookup(chainId, pair)
  if (!row) return null
  return { base: row.baseToken, quote: row.quoteToken }
}

/**
 * 取某链某交易对的代币小数位；种子对为 18/18（MockERC20 口径），自助对取
 * 注册表元数据；解析不到返回 null（调用方回退 18/18 展示口径）。
 */
export function getPairDecimals(
  chainId: number,
  pair: string,
): { base: number; quote: number } | null {
  if (isTradePair(pair)) return { base: SEED_DECIMALS, quote: SEED_DECIMALS }
  const key = parseListedKey(pair)
  if (!key || key.chainId !== chainId) return null
  const row = listedPairCacheLookup(chainId, pair)
  if (!row) return null
  return { base: row.baseDecimals, quote: row.quoteDecimals }
}
