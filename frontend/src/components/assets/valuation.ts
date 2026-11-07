/**
 * 资产估值聚合（第 31 轮，纯函数）：口径写死——
 * 总估值只汇总有已验证 Chainlink 价格的代币（USDT 按 1:1）；无价代币即使有余额
 * 也只列入 unpricedHeld 供页面明示排除，绝不按 0 或编造价计入。
 * 24h 估值变化 = 当前总估值 vs 本地记录的 24h 前快照（同口径），没有够老的快照返回 null。
 */

export interface TokenBalance {
  symbol: string
  wallet: number
  vaultTotal: number
  vaultAvailable: number
  vaultLocked: number
}

export interface ValuedToken extends TokenBalance {
  /** 已验证参考价（美元）；无已验证价格为 null */
  priceUsd: number | null
  /** (钱包 + Vault 总额) × 价格；无价为 null */
  valueUsd: number | null
}

export interface ValuationResult {
  rows: ValuedToken[]
  /** 仅有价代币的估值合计 */
  totalValue: number
  /** 有余额但无已验证价格的代币符号（页面须明示未计入） */
  unpricedHeld: string[]
  /** 分布条：有价且价值 > 0 的代币占比（按价值降序） */
  distribution: { symbol: string; pct: number; value: number }[]
}

export function valueTokens(
  balances: readonly TokenBalance[],
  prices: ReadonlyMap<string, number>,
): ValuationResult {
  const rows: ValuedToken[] = balances.map((b) => {
    const price = prices.get(b.symbol) ?? null
    const totalQty = b.wallet + b.vaultTotal
    return {
      ...b,
      priceUsd: price,
      valueUsd: price !== null ? totalQty * price : null,
    }
  })
  const totalValue = rows.reduce((acc, r) => acc + (r.valueUsd ?? 0), 0)
  const unpricedHeld = rows
    .filter((r) => r.priceUsd === null && r.wallet + r.vaultTotal > 0)
    .map((r) => r.symbol)
  const distribution = rows
    .filter((r) => r.valueUsd !== null && r.valueUsd > 0)
    .map((r) => ({
      symbol: r.symbol,
      value: r.valueUsd as number,
      pct: totalValue > 0 ? ((r.valueUsd as number) / totalValue) * 100 : 0,
    }))
    .sort((a, b) => b.value - a.value)
  return { rows, totalValue, unpricedHeld, distribution }
}

/* ---------- 24h 估值快照（本地记录） ---------- */

export interface ValuationSnapshot {
  /** unix 毫秒 */
  t: number
  total: number
}

const SNAPSHOT_KEY = 'b100.valuationSnapshots'
const MAX_SNAPSHOTS = 400
const MIN_RECORD_GAP_MS = 10 * 60 * 1000 // 同口径总额 10 分钟内不重复记
const KEEP_MS = 35 * 24 * 3600 * 1000

export function loadSnapshots(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): ValuationSnapshot[] {
  if (!storage) return []
  try {
    const parsed = JSON.parse(storage.getItem(SNAPSHOT_KEY) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (s): s is ValuationSnapshot =>
          typeof s === 'object' && s !== null &&
          typeof (s as ValuationSnapshot).t === 'number' &&
          typeof (s as ValuationSnapshot).total === 'number',
      )
      .sort((a, b) => a.t - b.t)
  } catch {
    return []
  }
}

export function recordSnapshot(
  snaps: readonly ValuationSnapshot[],
  total: number,
  now: number,
  storage: Pick<Storage, 'setItem'> | undefined = safeStorage(),
): ValuationSnapshot[] {
  const pruned = snaps.filter((s) => now - s.t <= KEEP_MS)
  const last = pruned[pruned.length - 1]
  if (last && now - last.t < MIN_RECORD_GAP_MS && Math.abs(last.total - total) < 1e-9) {
    return [...pruned]
  }
  const next = [...pruned, { t: now, total }].slice(-MAX_SNAPSHOTS)
  if (storage) {
    try {
      storage.setItem(SNAPSHOT_KEY, JSON.stringify(next))
    } catch {
      // 存储不可用时快照只在内存中，24h 变化行会如实不显示
    }
  }
  return next
}

export interface Change24h {
  pct: number
  /** 迷你走势线数据（截至当前的快照序列，带真实时间戳） */
  spark: { t: number; v: number }[]
}

/** 与约 24h 前的快照比较；没有至少 23h 前的快照时返回 null（界面显示「记录中」） */
export function changeVs24h(
  snaps: readonly ValuationSnapshot[],
  currentTotal: number,
  now: number,
): Change24h | null {
  const cutoff = now - 24 * 3600 * 1000
  const tolerance = now - 23 * 3600 * 1000
  const past = [...snaps].filter((s) => s.t <= tolerance).sort((a, b) => a.t - b.t)
  if (past.length === 0) return null
  const base = past[past.length - 1] // 最接近 24h 前的一张
  void cutoff
  if (base.total <= 0) return null
  const spark = [...snaps.map((s) => ({ t: s.t, v: s.total })), { t: now, v: currentTotal }]
  return { pct: ((currentTotal - base.total) / base.total) * 100, spark }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined
  } catch {
    return undefined
  }
}

export function fmtUsd(n: number, digits = 2): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
