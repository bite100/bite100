/**
 * 市价单纯计算（第十七轮，设计见 docs/market-orders.md）：
 * 保护价推导与按当前盘口的预估成交试算。全部为普通单位（非 wei）数值运算，
 * 与订单簿行的人类单位口径一致；真正提交时价格在签名层换算为定点。
 */

export interface MarketBookLevel {
  price: string
  amount: string
}

export type OrderSide = 'buy' | 'sell'

/** 对手盘最优价（买单看卖盘最低价、卖单看买盘最高价）；盘口为空返回 null */
export function bestOppositePrice(
  side: OrderSide,
  bids: MarketBookLevel[],
  asks: MarketBookLevel[]
): number | null {
  const levels = side === 'buy' ? asks : bids
  let best: number | null = null
  for (const l of levels) {
    const p = parseFloat(l.price)
    if (!Number.isFinite(p) || p <= 0) continue
    if (best == null || (side === 'buy' ? p < best : p > best)) best = p
  }
  return best
}

/**
 * 保护价：用户签名的价格上限/下限。买入 = 最优卖价 × (1 + 滑点%)，
 * 卖出 = 最优买价 × (1 − 滑点%)。滑点被钳制在 [0, 50]。
 */
export function protectionPrice(side: OrderSide, bestOpposite: number, slippagePct: number): number {
  const s = Math.min(50, Math.max(0, Number.isFinite(slippagePct) ? slippagePct : 0)) / 100
  return side === 'buy' ? bestOpposite * (1 + s) : bestOpposite * (1 - s)
}

export interface MarketFillEstimate {
  /** 按当前盘口与保护价可成交的数量（base 口径） */
  filledQty: number
  /** 预估成交均价（quote/base）；无可成交量时为 null */
  avgPrice: number | null
  /** 预估成交总额（quote 口径） */
  notional: number
  /** 数量是否可被盘口全额吃掉（在保护价内） */
  fullyFilled: boolean
  /** 是否有档位因越过保护价而吃不到（深度本身够、价格不够） */
  cappedByProtection: boolean
}

/**
 * 逐档试算：按最优价向外走 levels（对手盘），价格越过保护价即停。
 * levels 顺序不敏感，内部按方向排序。
 */
export function estimateMarketFill(
  side: OrderSide,
  amount: number,
  levels: MarketBookLevel[],
  protection: number
): MarketFillEstimate {
  const want = Number.isFinite(amount) && amount > 0 ? amount : 0
  const sorted = levels
    .map((l) => ({ price: parseFloat(l.price), qty: parseFloat(l.amount) }))
    .filter((l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.qty) && l.qty > 0)
    .sort((a, b) => (side === 'buy' ? a.price - b.price : b.price - a.price))

  let remaining = want
  let filledQty = 0
  let notional = 0
  let cappedByProtection = false
  for (const l of sorted) {
    const within = side === 'buy' ? l.price <= protection : l.price >= protection
    if (!within) {
      cappedByProtection = true
      break
    }
    if (remaining <= 0) break
    const take = Math.min(remaining, l.qty)
    filledQty += take
    notional += take * l.price
    remaining -= take
  }
  return {
    filledQty,
    avgPrice: filledQty > 0 ? notional / filledQty : null,
    notional,
    fullyFilled: want > 0 && remaining <= 1e-12,
    cappedByProtection,
  }
}
