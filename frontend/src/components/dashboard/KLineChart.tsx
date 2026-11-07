import { useEffect, useRef } from 'react'
import { createChart, CandlestickSeries, type IChartApi, type ISeriesApi } from 'lightweight-charts'
import { useTradesOHLC } from '../../hooks/useTradesOHLC'
import { Text } from '@mantine/core'

const DEFAULT_PAIR = 'TKA/TKB'

const CHART_HEIGHT_DESKTOP = 380
const CHART_HEIGHT_MOBILE = 280

/** K 线图：从 /api/trades 聚合 1h OHLC，并订阅 WS trade 实时更新（浅底、绿涨红跌，涨跌色仅数据语义） */
export function KLineChart() {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const { bars, loading, error } = useTradesOHLC(DEFAULT_PAIR, 3600)

  useEffect(() => {
    if (!containerRef.current) return
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 768
    const chartHeight = isMobile ? CHART_HEIGHT_MOBILE : CHART_HEIGHT_DESKTOP

    const chart = createChart(containerRef.current, {
      width: containerRef.current.offsetWidth,
      height: chartHeight,
      layout: {
        background: { color: '#FFFFFF' },
        textColor: '#737378',
      },
      grid: {
        vertLines: { color: '#F0F0F2' },
        horzLines: { color: '#F0F0F2' },
      },
      rightPriceScale: { borderColor: '#E2E2E7' },
      timeScale: { borderColor: '#E2E2E7', timeVisible: true, secondsVisible: false },
    })

    const candlestickSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#30A46C',
      downColor: '#E5484D',
      borderDownColor: '#E5484D',
      borderUpColor: '#30A46C',
      wickUpColor: '#30A46C',
      wickDownColor: '#E5484D',
    })

    chartRef.current = chart
    seriesRef.current = candlestickSeries

    const handleResize = () => {
      if (!containerRef.current || !chartRef.current) return
      const mobile = window.innerWidth < 768
      const h = mobile ? CHART_HEIGHT_MOBILE : CHART_HEIGHT_DESKTOP
      chartRef.current.applyOptions({ width: containerRef.current.offsetWidth, height: h } as unknown as Parameters<IChartApi['applyOptions']>[0])
    }
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [])

  // 当 bars 从 API/WS 更新时写入图表
  useEffect(() => {
    const series = seriesRef.current
    if (!series || bars.length === 0) return
    const chartData = bars.map((b) => ({
      time: b.time as unknown as string,
      open: Number(b.open.toFixed(6)),
      high: Number(b.high.toFixed(6)),
      low: Number(b.low.toFixed(6)),
      close: Number(b.close.toFixed(6)),
    }))
    series.setData(chartData)
  }, [bars])

  return (
    <div className="kline-chart-wrap" style={{ width: '100%', minHeight: CHART_HEIGHT_DESKTOP }}>
      {loading && <Text size="xs" c="dimmed">K 线加载中…</Text>}
      {error && <Text size="xs" c="red">K 线加载失败：{error}</Text>}
      <div ref={containerRef} style={{ width: '100%', minHeight: CHART_HEIGHT_DESKTOP }} />
    </div>
  )
}
