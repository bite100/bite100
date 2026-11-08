/**
 * 紧凑盘口与深度图的聚合逻辑（第 31 轮，纯函数）：
 * - 精度聚合：按价格步长把多档合并成一档（买盘向下取整、卖盘向上取整，保证聚合价不优于真实最优价）；
 * - 买卖强度：可见档位累计量之比；
 * - 深度图序列：从最优价向外累计的阶梯点（与紧凑盘口同一份快照同源计算）。
 */

export interface BookLevelIn {
  price: number
  amount: number
}

export interface AggregatedLevel extends BookLevelIn {
  /** 从最优价累计到本档的数量 */
  total: number
}

/** 按交易对价格量级给默认精度档位（演示图 BTC/USDT 为 0.50 起） */
export function stepOptionsFor(lastPrice: number | null): number[] {
  if (lastPrice == null || !Number.isFinite(lastPrice) || lastPrice <= 0) return [0.01, 0.1, 0.5, 1]
  const magnitude = Math.pow(10, Math.floor(Math.log10(lastPrice)))
  const base = magnitude / 100 // 价格 1e2~1e3 → 1 起步；1e4~1e5 → 100 起步的 1/100 量级
  const steps = [base / 2, base, base * 5, base * 10, base * 50].filter((s) => s > 0)
  return [...new Set(steps.map((s) => Number(s.toPrecision(2))))]
}

/**
 * 把按最优价优先排序的档位按步长聚合（step <= 0 表示不聚合）。
 * bids 传入降序、asks 传入升序；聚合键：买盘 floor、卖盘 ceil。
 */
export function aggregateLevels(
  levels: readonly BookLevelIn[],
  step: number,
  side: 'buy' | 'sell',
): AggregatedLevel[] {
  const valid = levels.filter((l) => Number.isFinite(l.price) && l.price > 0 && l.amount > 0)
  const grouped: BookLevelIn[] = []
  for (const l of valid) {
    let p = l.price
    if (step > 0) {
      p = side === 'buy' ? Math.floor(l.price / step) * step : Math.ceil(l.price / step) * step
      p = Number(p.toFixed(10))
    }
    const last = grouped[grouped.length - 1]
    if (last && last.price === p) last.amount += l.amount
    else grouped.push({ price: p, amount: l.amount })
  }
  let acc = 0
  return grouped.map((g) => {
    acc += g.amount
    return { ...g, total: acc }
  })
}

/** 买卖强度（%）：两侧可见累计量之比；任一侧为空返回 null（界面不显示强度条） */
export function powerBarPct(
  bids: readonly AggregatedLevel[],
  asks: readonly AggregatedLevel[],
): { buyPct: number; sellPct: number } | null {
  const b = bids.length ? bids[bids.length - 1].total : 0
  const a = asks.length ? asks[asks.length - 1].total : 0
  if (b <= 0 || a <= 0) return null
  const buyPct = Math.round((b / (a + b)) * 100)
  return { buyPct, sellPct: 100 - buyPct }
}

export interface DepthPoint {
  price: number
  cum: number
}

export interface DepthSeries {
  /** 买盘：价格从低到高（绘图时左段），cum 为从最优买价累计 */
  bids: DepthPoint[]
  /** 卖盘：价格从低到高，cum 为从最优卖价累计 */
  asks: DepthPoint[]
  mid: number
  spreadPct: number
}

/**
 * 深度图序列：输入人类单位档位（bids 降序 / asks 升序，与订单簿组件口径一致）。
 * 输出按价格升序的累计点，绘图组件据此画阶梯线；空盘返回 null（界面显示空状态，不画假曲线）。
 */
export function depthSeries(
  bidsIn: readonly BookLevelIn[],
  asksIn: readonly BookLevelIn[],
  lastPrice: number | null,
): DepthSeries | null {
  const bids = bidsIn.filter((l) => l.price > 0 && l.amount > 0)
  const asks = asksIn.filter((l) => l.price > 0 && l.amount > 0)
  if (bids.length === 0 && asks.length === 0) return null
  const bestBid = bids.length ? Math.max(...bids.map((b) => b.price)) : null
  const bestAsk = asks.length ? Math.min(...asks.map((a) => a.price)) : null
  const mid =
    bestBid != null && bestAsk != null
      ? (bestBid + bestAsk) / 2
      : (lastPrice ?? bestBid ?? bestAsk ?? 0)
  if (mid <= 0) return null

  // 买盘累计：从最优（最高价）向外累加，再翻转为价格升序输出
  const bidsDesc = [...bids].sort((x, y) => y.price - x.price)
  let acc = 0
  const bidPointsDesc = bidsDesc.map((l) => {
    acc += l.amount
    return { price: l.price, cum: acc }
  })
  const bidPoints = [...bidPointsDesc].reverse()
  const asksAsc = [...asks].sort((x, y) => x.price - y.price)
  acc = 0
  const askPoints = asksAsc.map((l) => {
    acc += l.amount
    return { price: l.price, cum: acc }
  })
  const spreadPct =
    bestBid != null && bestAsk != null && mid > 0 ? ((bestAsk - bestBid) / mid) * 100 : 0
  return { bids: bidPoints, asks: askPoints, mid, spreadPct }
}

/* ---------- lightweight-charts 数据映射（深度图用） ---------- */

export interface DepthChartPoint {
  /** 合成时间戳（秒）：价格 ×100 取整——深度图的横轴是价格而非时间，
   *  借 lightweight-charts 的时间轴承载价格刻度（时间轴本身隐藏，价格标签由组件按比例另行渲染） */
  time: number
  value: number
}

/**
 * 把深度序列映射成两条 Area/Line series 的数据：
 * - 横轴按价格比例间距（time = round(price × 100)），重复/过密时强制单调递增；
 * - 买盘在「最优买价 → 中间价」之间补一段平台（= 全部买盘累计），卖盘在「中间价 → 最优卖价」同理，
 *   与深度图的累计语义一致（中间价处两侧深度都取全量）。
 */
export function depthChartData(series: DepthSeries): { bids: DepthChartPoint[]; asks: DepthChartPoint[] } {
  const toTime = (price: number) => Math.max(1, Math.round(price * 100))
  const monotonic = (pts: DepthChartPoint[]): DepthChartPoint[] => {
    const out: DepthChartPoint[] = []
    for (const p of pts) {
      const last = out[out.length - 1]
      if (last && p.time <= last.time) out.push({ time: last.time + 1, value: p.value })
      else out.push(p)
    }
    return out
  }
  const totalBid = series.bids.reduce((m, p) => Math.max(m, p.cum), 0)
  const totalAsk = series.asks.reduce((m, p) => Math.max(m, p.cum), 0)
  const bids = monotonic([
    ...series.bids.map((p) => ({ time: toTime(p.price), value: p.cum })),
    ...(series.bids.length ? [{ time: toTime(series.mid), value: totalBid }] : []),
  ])
  const asks = monotonic([
    ...(series.asks.length ? [{ time: toTime(series.mid), value: totalAsk }] : []),
    ...series.asks.map((p) => ({ time: toTime(p.price), value: p.cum })),
  ])
  return { bids, asks }
}
