/**
 * 深度图（第 31 轮 §12.5）：与紧凑盘口同一份快照聚合出的累计阶梯图——
 * 买盘从中间价向左累计、卖盘向右累计，中间价虚线。空盘显示空状态，不画假曲线。
 */
import { useMemo } from 'react'
import { depthSeries, type BookLevelIn } from './depthAggregate'
import { fmtPrice } from './tradeFormat'
import './DepthChart.css'

interface DepthChartProps {
  bids: BookLevelIn[]
  asks: BookLevelIn[]
  lastPrice: number | null
  base: string
}

const W = 340
const H = 190
const PAD_L = 6
const PAD_R = 6
const PAD_T = 10
const PAD_B = 20

/** 累计点 → SVG 阶梯路径（先水平后垂直） */
function stepPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return ''
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length; i++) {
    d += ` H ${points[i].x} V ${points[i].y}`
  }
  return d
}

export function DepthChart({ bids, asks, lastPrice, base }: DepthChartProps) {
  const series = useMemo(() => depthSeries(bids, asks, lastPrice), [bids, asks, lastPrice])

  if (!series) {
    return (
      <div className="depth-chart depth-empty">
        <p>暂无盘口数据，深度图无法绘制。</p>
        <p className="depth-empty-sub">有人挂单后，这里会按同一份盘口画出买卖双方的累计深度。</p>
      </div>
    )
  }

  // X 轴：以中间价为中心，两侧取相同价格跨度（较大一侧为准），保证中线居中
  const minBid = series.bids.length ? series.bids[0].price : series.mid
  const maxAsk = series.asks.length ? series.asks[series.asks.length - 1].price : series.mid
  const span = Math.max(series.mid - minBid, maxAsk - series.mid, series.mid * 0.001)
  const x0 = series.mid - span
  const x1 = series.mid + span
  const maxCum = Math.max(
    series.bids.length ? series.bids[series.bids.length - 1].cum : 0,
    series.asks.length ? series.asks[series.asks.length - 1].cum : 0,
    0,
  )
  const px = (price: number) => PAD_L + ((price - x0) / (x1 - x0)) * (W - PAD_L - PAD_R)
  const py = (cum: number) => PAD_T + (1 - cum / (maxCum || 1)) * (H - PAD_T - PAD_B)
  const midX = px(series.mid)
  const baseY = H - PAD_B

  const bidPts = series.bids.map((p) => ({ x: px(p.price), y: py(p.cum) }))
  const askPts = series.asks.map((p) => ({ x: px(p.price), y: py(p.cum) }))
  // 阶梯线从中间价基线起步：买盘在中线处从最高累计开始（最优档累计在最右）
  const bidLine = bidPts.length
    ? stepPath([...bidPts, { x: midX, y: bidPts[bidPts.length - 1].y }])
    : ''
  const askLine = askPts.length
    ? stepPath([{ x: midX, y: askPts[0].y }, ...askPts])
    : ''
  const bidArea = bidLine ? `${bidLine} L ${midX} ${baseY} L ${bidPts[0].x} ${baseY} Z` : ''
  const askArea = askLine
    ? `${askLine} L ${askPts[askPts.length - 1].x} ${baseY} L ${midX} ${baseY} Z`
    : ''

  return (
    <div className="depth-chart">
      <div className="depth-legend">
        <span>
          <i style={{ background: 'var(--b100-up)' }} />
          买盘累计
        </span>
        <span>
          <i style={{ background: 'var(--b100-down)' }} />
          卖盘累计
        </span>
        <span className="num">中间价 {fmtPrice(series.mid)}</span>
        <span className="num">价差 {series.spreadPct.toFixed(2)}%</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="depth-svg" role="img" aria-label={`${base} 深度图`}>
        {bidArea && <path d={bidArea} fill="rgba(3,152,85,0.12)" />}
        {askArea && <path d={askArea} fill="rgba(217,45,32,0.10)" />}
        {bidLine && <path d={bidLine} fill="none" stroke="var(--b100-up)" strokeWidth="1.6" />}
        {askLine && <path d={askLine} fill="none" stroke="var(--b100-down)" strokeWidth="1.6" />}
        <line x1={midX} x2={midX} y1={PAD_T} y2={baseY} stroke="#c9c9cf" strokeDasharray="4 3" />
        <text x={PAD_L} y={H - 6} fontSize="9" fill="var(--b100-text-3)" className="num">
          {fmtPrice(x0)}
        </text>
        <text x={midX} y={H - 6} fontSize="9" fill="var(--b100-text-3)" textAnchor="middle" className="num">
          {fmtPrice(series.mid)}
        </text>
        <text x={W - PAD_R} y={H - 6} fontSize="9" fill="var(--b100-text-3)" textAnchor="end" className="num">
          {fmtPrice(x1)}
        </text>
        <text x={W - PAD_R} y={PAD_T + 2} fontSize="9" fill="var(--b100-text-3)" textAnchor="end" className="num">
          累计 {maxCum.toFixed(2)} {base}
        </text>
      </svg>
    </div>
  )
}
