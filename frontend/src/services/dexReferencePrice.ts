/**
 * DexScreener 参考价客户端（第六十轮）：自助上架代币的参考价骑现成聚合
 * 报价——DexScreener 免费公开 API（无需 key，文档限流 300 次/分钟，
 * 调研记录见 docs/round60-self-listing-2026-11-10.md §1）。
 *
 * 端点：GET https://api.dexscreener.com/tokens/v1/{链 slug}/{代币地址}
 * 返回该代币的池子数组（含 priceUsd 字符串、liquidity.usd、交易对构成）。
 * 取「代币作为 baseToken 且流动性最大」的池子的 USD 价。任何失败/无池/
 * 无主网 slug → 返回 null（上层据此老实显示「暂无参考价」，绝不编造）。
 *
 * 注意：DexScreener 不索引测试网，测试网自助币恒返回 null——这是事实口径，
 * 不是故障。slug 映射只列主网链；测试网链（11155111/84532 等）直接 null。
 */
import { withTimeout } from '../utils'

/** DexScreener 链 slug（仅主网链；测试网不索引） */
export const DEXSCREENER_CHAIN_SLUGS: Record<number, string> = {
  1: 'ethereum',
  8453: 'base',
  56: 'bsc',
  137: 'polygon',
  42161: 'arbitrum',
  10: 'optimism',
}

interface DexPoolJson {
  priceUsd?: string
  liquidity?: { usd?: number }
  baseToken?: { address?: string }
  quoteToken?: { address?: string }
}

const CACHE_TTL_MS = 60_000
const cache = new Map<string, { usd: number | null; at: number }>()

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

/** 从 DexScreener 池子数组里挑该代币的 USD 价：baseToken 命中、流动性最大 */
export function pickDexUsdPrice(pools: unknown, tokenAddress: string): number | null {
  if (!Array.isArray(pools)) return null
  const want = tokenAddress.toLowerCase()
  let best: number | null = null
  let bestLiq = -1
  for (const raw of pools as DexPoolJson[]) {
    if (!raw || typeof raw !== 'object') continue
    if ((raw.baseToken?.address ?? '').toLowerCase() !== want) continue
    const usd = Number(raw.priceUsd)
    if (!Number.isFinite(usd) || usd <= 0) continue
    const liq = Number(raw.liquidity?.usd ?? 0)
    if (liq > bestLiq) {
      bestLiq = liq
      best = usd
    }
  }
  return best
}

/** 单个代币的 USD 参考价（带 60 秒缓存）；查不到/失败 → null */
export async function fetchDexTokenUsdPrice(
  chainId: number,
  tokenAddress: string,
  deps: { fetchFn?: FetchFn; nowMs?: number } = {},
): Promise<number | null> {
  const slug = DEXSCREENER_CHAIN_SLUGS[chainId]
  if (!slug) return null
  const key = `${chainId}:${tokenAddress.toLowerCase()}`
  const now = deps.nowMs ?? Date.now()
  const hit = cache.get(key)
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.usd
  const fetchFn = deps.fetchFn ?? ((url: string, init?: RequestInit) => fetch(url, init))
  let usd: number | null = null
  try {
    const res = await withTimeout(
      fetchFn(`https://api.dexscreener.com/tokens/v1/${slug}/${tokenAddress.toLowerCase()}`, {
        signal: AbortSignal.timeout(8000),
      }),
      8000,
      'dexscreener',
    )
    if (res.ok) {
      const data = (await res.json()) as unknown
      usd = pickDexUsdPrice(data, tokenAddress)
    }
  } catch {
    usd = null
  }
  cache.set(key, { usd, at: now })
  return usd
}

/** 一对代币的 USD 价（并行）；任一为 null 即该腿无参考 */
export async function fetchDexPairUsdPrices(
  chainId: number,
  baseAddress: string,
  quoteAddress: string,
  deps: { fetchFn?: FetchFn; nowMs?: number } = {},
): Promise<{ baseUsd: number | null; quoteUsd: number | null }> {
  const [baseUsd, quoteUsd] = await Promise.all([
    fetchDexTokenUsdPrice(chainId, baseAddress, deps),
    fetchDexTokenUsdPrice(chainId, quoteAddress, deps),
  ])
  return { baseUsd, quoteUsd }
}
