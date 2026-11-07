/**
 * 深度图（第 31 轮 §12.5）：与紧凑盘口同一份快照聚合出的累计阶梯图——
 * 买盘从中间价向左累计、卖盘向右累计。渲染骑项目已引入的 lightweight-charts
 * （与 K 线同一引擎）：两条 AreaSeries（WithSteps 阶梯线）。
 * 注意：lightweight-charts 的横轴是时间轴，深度图横轴是价格——这里按
 * depthAggregate.depthChartData 的口径把价格按比例映射为合成时间承载刻度，
 * 时间轴隐藏，价格标签（低/中/高）由本组件按比例在图下另行渲染。
 * 空盘显示空状态，不画假曲线。
 */
import { useEffect, useMemo, useRef } from 'react'
import {
  createChart,
  AreaSeries,
  LineType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import { depthChartData, depthSeries, type BookLevelIn } from './depthAggregate'
import { fmtPrice } from './tradeFormat'
import './DepthChart.css'

interface DepthChartProps {
  bids: BookLevelIn[]
  asks: BookLevelIn[]
  lastPrice: number | null
  base: string
}

const CHART_HEIGHT = 190

export function DepthChart({ bids, asks, lastPrice, base }: DepthChartProps) {
  const series = useMemo(() => depthSeries(bids, asks, lastPrice), [bids, asks, lastPrice])
  const chartData = useMemo(() => (series ? depthChartData(series) : null), [series])
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const bidSeriesRef = useRef<ISeriesApi<'Area'> | null>(null)
  const askSeriesRef = useRef<ISeriesApi<'Area'> | null>(null)

  // 建图（一次）：浅色主题与 K 线一致；横轴（合成时间）隐藏，纵轴为累计数量
  useEffect(() => {
    if (!containerRef.current || !series) return
    const chart = createChart(containerRef.current, {
      width: containerRef.current.offsetWidth,
      height: CHART_HEIGHT,
      layout: {
        background: { color: '#FFFFFF' },
        textColor: '#737378',
        fontSize: 11,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: '#F1F1F4' },
        horzLines: { color: '#F1F1F4' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#E2E2E7' },
      timeScale: { visible: false },
      handleScroll: false,
      handleScale: false,
    })
    const bidSeries = chart.addSeries(AreaSeries, {
      lineColor: '#039855',
      topColor: 'rgba(3, 152, 85, 0.22)',
      bottomColor: 'rgba(3, 152, 85, 0.02)',
      lineWidth: 2,
      lineType: LineType.WithSteps,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    const askSeries = chart.addSeries(AreaSeries, {
      lineColor: '#d92d20',
      topColor: 'rgba(217, 45, 32, 0.20)',
      bottomColor: 'rgba(217, 45, 32, 0.02)',
      lineWidth: 2,
      lineType: LineType.WithSteps,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    chartRef.current = chart
    bidSeriesRef.current = bidSeries
    askSeriesRef.current = askSeries

    const handleResize = () => {
      if (!containerRef.current || !chartRef.current) return
      chartRef.current.applyOptions({ width: containerRef.current.offsetWidth })
    }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      chart.remove()
      chartRef.current = null
      bidSeriesRef.current = null
      askSeriesRef.current = null
    }
    // 只建一次；series 为空时组件走空状态分支不会挂载容器
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series === null])

  // 数据写入
  useEffect(() => {
    if (!chartData) return
    const asTime = (t: number) => t as unknown as UTCTimestamp
    bidSeriesRef.current?.setData(chartData.bids.map((p) => ({ time: asTime(p.time), value: p.value })))
    askSeriesRef.current?.setData(chartData.asks.map((p) => ({ time: asTime(p.time), value: p.value })))
    chartRef.current?.timeScale().fitContent()
  }, [chartData])

  if (!series || !chartData) {
    return (
      <div className="depth-chart depth-empty">
        <p>暂无盘口数据，深度图无法绘制。</p>
        <p className="depth-empty-sub">有人挂单后，这里会按同一份盘口画出买卖双方的累计深度。</p>
      </div>
    )
  }

  const minPrice = series.bids.length ? series.bids[0].price : series.mid
  const maxPrice = series.asks.length ? series.asks[series.asks.length - 1].price : series.mid
  const midPct = maxPrice > minPrice ? ((series.mid - minPrice) / (maxPrice - minPrice)) * 100 : 50
  const maxCum = Math.max(
    series.bids.reduce((m, p) => Math.max(m, p.cum), 0),
    series.asks.reduce((m, p) => Math.max(m, p.cum), 0),
  )

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
        <span className="num">
          累计上限 {maxCum.toFixed(2)} {base}
        </span>
      </div>
      <div ref={containerRef} className="depth-canvas" />
      <div className="depth-prices num" aria-hidden="true">
        <span className="depth-price-min">{fmtPrice(minPrice)}</span>
        <span className="depth-price-mid" style={{ left: `${midPct}%` }}>
          {fmtPrice(series.mid)}
        </span>
        <span className="depth-price-max">{fmtPrice(maxPrice)}</span>
      </div>
    </div>
  )
}
