/**
 * 行情列表的纯逻辑（第 31 轮）：本地收藏、筛选、排序。
 * 价格口径（设计 §3.3，写死）：最新价只用本所成交，无成交 → null（界面显示「暂无成交」）；
 * $ 小字只用 Chainlink 参考价；24h 数据与交易页同源（usePairStats）。
 */

export interface MarketRowData {
  pair: string
  base: string
  quote: string
  /** 本所最近成交价（人类单位）；无成交为 null */
  lastPrice: number | null
  /** 24h 涨跌 %（本所成交推导）；无成交为 null */
  changePct: number | null
  /** 24h 成交额（计价币种，人类单位） */
  volumeQuote: number | null
  /** Chainlink 参考价（美元）；无已验证喂价为 null */
  refUsd: number | null
  /** Vault 任一侧代币有余额 */
  held: boolean
}

export type MarketTabFilter = 'all' | 'fav' | 'held'
export type MarketSortKey = 'volume' | 'price' | 'change'
export type SortDir = 'asc' | 'desc'

const FAVORITES_KEY = 'b100.favPairs'

export function loadFavorites(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): string[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(FAVORITES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

export function saveFavorites(
  favorites: readonly string[],
  storage: Pick<Storage, 'setItem'> | undefined = safeStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(FAVORITES_KEY, JSON.stringify([...favorites]))
  } catch {
    // 本地存储不可用时收藏仅保存在内存里，不阻断行情浏览
  }
}

export function toggleFavorite(favorites: readonly string[], pair: string): string[] {
  return favorites.includes(pair)
    ? favorites.filter((p) => p !== pair)
    : [...favorites, pair]
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined
  } catch {
    return undefined
  }
}

export function filterMarketRows(
  rows: readonly MarketRowData[],
  query: string,
  tab: MarketTabFilter,
  favorites: ReadonlySet<string>,
): MarketRowData[] {
  const q = query.trim().toLowerCase()
  return rows.filter((r) => {
    if (tab === 'fav' && !favorites.has(r.pair)) return false
    if (tab === 'held' && !r.held) return false
    if (!q) return true
    return (
      r.pair.toLowerCase().includes(q) ||
      r.base.toLowerCase().includes(q) ||
      r.quote.toLowerCase().includes(q)
    )
  })
}

/** 排序：null（无成交）永远沉底，不参与升降序翻转 */
export function sortMarketRows(
  rows: readonly MarketRowData[],
  key: MarketSortKey,
  dir: SortDir,
): MarketRowData[] {
  const value = (r: MarketRowData): number | null =>
    key === 'volume' ? r.volumeQuote : key === 'price' ? r.lastPrice : r.changePct
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const va = value(a)
    const vb = value(b)
    if (va === null && vb === null) return a.pair.localeCompare(b.pair)
    if (va === null) return 1
    if (vb === null) return -1
    if (va !== vb) return (va - vb) * sign
    return a.pair.localeCompare(b.pair)
  })
}

/** 代币展示元信息（行情行图标与全名；颜色与设计演示图一致） */
export const TOKEN_META: Record<string, { name: string; glyph: string; bg: string; fg: string }> = {
  BTC: { name: 'Bitcoin', glyph: '₿', bg: '#f7931a', fg: '#fff' },
  ETH: { name: 'Ethereum', glyph: 'Ξ', bg: '#627eea', fg: '#fff' },
  SOL: { name: 'Solana', glyph: '◎', bg: '#9945ff', fg: '#fff' },
  BNB: { name: 'BNB', glyph: 'B', bg: '#f0b90b', fg: '#fff' },
  XRP: { name: 'XRP', glyph: 'X', bg: '#23292f', fg: '#fff' },
  DOGE: { name: 'Dogecoin', glyph: 'Ð', bg: '#c2a633', fg: '#fff' },
  LINK: { name: 'Chainlink', glyph: '⬡', bg: '#2a5ada', fg: '#fff' },
  USDT: { name: 'Tether USD', glyph: '₮', bg: '#26a17b', fg: '#fff' },
  TKA: { name: 'Bit100 Token A', glyph: 'A', bg: '#ff007a', fg: '#fff' },
  TKB: { name: 'Bit100 Token B', glyph: 'B', bg: '#6c5ce7', fg: '#fff' },
}

export function tokenMeta(symbol: string): { name: string; glyph: string; bg: string; fg: string } {
  return TOKEN_META[symbol] ?? { name: symbol, glyph: symbol.slice(0, 1), bg: '#8e8e96', fg: '#fff' }
}

/** 行情价格式：大价 2 位小数，小价保留更多有效位 */
export function fmtMarketPrice(n: number): string {
  const digits = n >= 100 ? 2 : n >= 1 ? 4 : 6
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  })
}

/** 成交额紧凑格式：12.4M / 345.6K / 98.20 */
export function fmtCompactAmount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toFixed(2)
}
