/**
 * 迷你走势线（第 31 轮）：骑 lightweight-charts 的 LineSeries——
 * 输入是真时间戳序列（估值快照 / NAV 采样都是时间序列，正是该库的本行），
 * 不再手绘 SVG。只画面积线本身：双轴、网格、十字线全关，静态不可交互。
 */
import { useEffect, useRef } from 'react'
import {
  createChart,
  LineSeries,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'

interface SparklineChartProps {
  /** 时间戳（毫秒）→ 数值，按时间升序 */
  points: { t: number; v: number }[]
  up: boolean
  height?: number
}

export function SparklineChart({ points, up, height = 36 }: SparklineChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      width: containerRef.current.offsetWidth,
      height,
      layout: {
        background: { color: 'transparent' },
        textColor: 'transparent',
        fontSize: 9,
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      crosshair: { mode: CrosshairMode.Hidden },
      rightPriceScale: { visible: false },
      timeScale: { visible: false },
      handleScroll: false,
      handleScale: false,
    })
    const s = chart.addSeries(LineSeries, {
      color: up ? '#039855' : '#d92d20',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    chartRef.current = chart
    seriesRef.current = s
    const handleResize = () => {
      if (!containerRef.current || !chartRef.current) return
      chartRef.current.applyOptions({ width: containerRef.current.offsetWidth })
    }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    seriesRef.current?.applyOptions({ color: up ? '#039855' : '#d92d20' })
  }, [up])

  useEffect(() => {
    if (!seriesRef.current) return
    const sorted = [...points].sort((a, b) => a.t - b.t)
    const data: { time: UTCTimestamp; value: number }[] = []
    let lastTime = 0
    for (const p of sorted) {
      let t = Math.floor(p.t / 1000)
      if (t <= lastTime) t = lastTime + 1
      lastTime = t
      data.push({ time: t as unknown as UTCTimestamp, value: p.v })
    }
    seriesRef.current.setData(data)
    chartRef.current?.timeScale().fitContent()
  }, [points])

  // 容器始终挂载（可见性由父组件按样本数决定），建图 effect 才能稳定拿到节点
  return <div ref={containerRef} style={{ width: '100%', height }} aria-hidden="true" />
}
