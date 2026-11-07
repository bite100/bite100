import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  CrosshairMode,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import { useTradesOHLC, type OHLCBar } from '../../hooks/useTradesOHLC'
import { Text } from '@mantine/core'
import { DEFAULT_PAIR } from '../../config/pairs'
import {
  fmtPrice,
  fmtTotal,
  fmtChartTime,
  priceDecimals,
  sma,
} from './tradeFormat'

const CHART_HEIGHT_DESKTOP = 400
const CHART_HEIGHT_MOBILE = 300

/**
 * 图表配色基准（2026-11-08 实测，见 docs/round28-chart-orderbook-ui-2026-11-08.md）：
 * 蜡烛涨 #089981 / 跌 #f23645 为 TradingView 现行默认（Hyperliquid 图表同值，
 * 像素采样实测）；成交量柱同色 45% 透明；MA7 金 #f0b90b、MA25 粉 #eb40b5
 * （Binance MA 线色，浅底上 MA7 由品牌黄 #fcd535 略加深以保可读性）。
 * 皮肤保持本站浅色体系：白底、浅灰网格、深灰十字光标。
 */
export const CHART_UP = '#089981'
export const CHART_DOWN = '#f23645'
const VOL_UP = 'rgba(8, 153, 129, 0.45)'
const VOL_DOWN = 'rgba(242, 54, 69, 0.45)'
const MA_FAST = '#f0b90b'
const MA_SLOW = '#eb40b5'
const MA_FAST_PERIOD = 7
const MA_SLOW_PERIOD = 25

/** 周期工具条：全部由同一份 /api/trades 成交数据按不同粒度聚合，无额外数据源 */
const INTERVALS = [
  { value: '900', label: '15m' },
  { value: '3600', label: '1H' },
  { value: '14400', label: '4H' },
  { value: '86400', label: '1D' },
]

interface LegendData {
  bar: OHLCBar
  maFast: number | null
  maSlow: number | null
}

const dtfParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
})

/** 时间轴刻度（JST）：按刻度粒度给不同格式，避免旧版「15:0」式截断 */
function tickFormatter(time: unknown, tickMarkType: TickMarkType): string {
  const sec = Number(time)
  if (!Number.isFinite(sec)) return ''
  switch (tickMarkType) {
    case TickMarkType.Year:
    case TickMarkType.Month:
      return dtfParts.format(new Date(sec * 1000))
    case TickMarkType.DayOfMonth:
      return fmtChartTime(sec).slice(0, 5)
    default:
      return fmtChartTime(sec).slice(6)
  }
}

/**
 * K 线图（第 28 轮视觉重做）：TradingView lightweight-charts（Apache-2.0，
 * 保留其署名 logo）专业浅色主题——蜡烛 + 成交量 + MA7/MA25 均线、
 * 十字光标带 OHLC 图例、最新价虚线与轴标签、JST 时间轴。
 * 数据仍来自 /api/trades 聚合（见 useTradesOHLC），无成交时给诚实空状态。
 */
export function KLineChart({ pair = DEFAULT_PAIR }: { pair?: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const maFastRef = useRef<ISeriesApi<'Line'> | null>(null)
  const maSlowRef = useRef<ISeriesApi<'Line'> | null>(null)
  const fitKeyRef = useRef('')
  const legendMapRef = useRef<Map<number, LegendData>>(new Map())
  const lastLegendRef = useRef<LegendData | null>(null)
  const [interval, setIntervalValue] = useState('3600')
  const [legend, setLegend] = useState<LegendData | null>(null)
  const { bars, loading, error } = useTradesOHLC(pair, Number(interval))

  const maFastData = useMemo(() => sma(bars.map((b) => b.close), MA_FAST_PERIOD), [bars])
  const maSlowData = useMemo(() => sma(bars.map((b) => b.close), MA_SLOW_PERIOD), [bars])

  // 建图（一次）：浅色专业主题
  useEffect(() => {
    if (!containerRef.current) return
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 768
    const chart = createChart(containerRef.current, {
      width: containerRef.current.offsetWidth,
      height: isMobile ? CHART_HEIGHT_MOBILE : CHART_HEIGHT_DESKTOP,
      layout: {
        background: { color: '#FFFFFF' },
        textColor: '#737378',
        fontSize: 11,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: '#F1F1F4' },
        horzLines: { color: '#F1F1F4' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#B9B9C0', labelBackgroundColor: '#191919' },
        horzLine: { color: '#B9B9C0', labelBackgroundColor: '#191919' },
      },
      rightPriceScale: { borderColor: '#E2E2E7' },
      timeScale: {
        borderColor: '#E2E2E7',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: unknown, tickMarkType: TickMarkType) =>
          tickFormatter(time, tickMarkType),
      },
      localization: {
        timeFormatter: (time: unknown) => fmtChartTime(Number(time)),
      },
    })

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: CHART_UP,
      downColor: CHART_DOWN,
      borderUpColor: CHART_UP,
      borderDownColor: CHART_DOWN,
      wickUpColor: CHART_UP,
      wickDownColor: CHART_DOWN,
      priceLineVisible: true,
      priceLineStyle: LineStyle.Dashed,
      priceLineWidth: 1,
      priceFormat: { type: 'custom', formatter: (p: number) => fmtPrice(p), minMove: 0.01 },
    })
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: '',
      lastValueVisible: false,
      priceLineVisible: false,
      priceFormat: { type: 'custom', formatter: (p: number) => fmtTotal(p), minMove: 0.01 },
    })
    const maFast = chart.addSeries(LineSeries, {
      color: MA_FAST,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    const maSlow = chart.addSeries(LineSeries, {
      color: MA_SLOW,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.06, bottom: 0.24 } })
    chart.priceScale('').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } })

    chartRef.current = chart
    candleRef.current = candle
    volumeRef.current = volume
    maFastRef.current = maFast
    maSlowRef.current = maSlow

    const onCrosshair = (param: { time?: unknown }) => {
      const t = param.time != null ? Number(param.time) : NaN
      const hit = Number.isFinite(t) ? legendMapRef.current.get(t) : undefined
      setLegend(hit ?? lastLegendRef.current)
    }
    chart.subscribeCrosshairMove(onCrosshair)

    const handleResize = () => {
      if (!containerRef.current || !chartRef.current) return
      const mobile = window.innerWidth < 768
      chartRef.current.applyOptions({
        width: containerRef.current.offsetWidth,
        height: mobile ? CHART_HEIGHT_MOBILE : CHART_HEIGHT_DESKTOP,
      })
    }
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      chart.unsubscribeCrosshairMove(onCrosshair)
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      volumeRef.current = null
      maFastRef.current = null
      maSlowRef.current = null
    }
  }, [])

  // 数据写入：蜡烛 + 成交量 + 均线；切对/切周期时重新 fitContent
  useEffect(() => {
    const candle = candleRef.current
    if (!candle) return
    const asTime = (t: number) => t as unknown as UTCTimestamp
    candle.setData(
      bars.map((b) => ({ time: asTime(b.time), open: b.open, high: b.high, low: b.low, close: b.close }))
    )
    volumeRef.current?.setData(
      bars.map((b) => ({
        time: asTime(b.time),
        value: b.volume,
        color: b.close >= b.open ? VOL_UP : VOL_DOWN,
      }))
    )
    const toLine = (vals: Array<number | null>) =>
      bars
        .map((b, i) => ({ time: asTime(b.time), value: vals[i] }))
        .filter((p): p is { time: UTCTimestamp; value: number } => p.value != null)
    maFastRef.current?.setData(toLine(maFastData))
    maSlowRef.current?.setData(toLine(maSlowData))

    // 图例查找表与默认（最后一根）图例
    const map = new Map<number, LegendData>()
    bars.forEach((b, i) => map.set(b.time, { bar: b, maFast: maFastData[i], maSlow: maSlowData[i] }))
    legendMapRef.current = map
    const last = bars.length
      ? { bar: bars[bars.length - 1], maFast: maFastData[bars.length - 1], maSlow: maSlowData[bars.length - 1] }
      : null
    lastLegendRef.current = last
    setLegend(last)

    // 最新价虚线颜色跟随最后一根涨跌（Binance/HL 口径）
    if (bars.length) {
      const lastBar = bars[bars.length - 1]
      candle.applyOptions({
        priceLineColor: lastBar.close >= lastBar.open ? CHART_UP : CHART_DOWN,
        priceFormat: {
          type: 'custom',
          formatter: (p: number) => fmtPrice(p),
          minMove: Math.pow(10, -priceDecimals(lastBar.close)),
        },
      })
    }

    const fitKey = `${pair}|${interval}`
    if (fitKeyRef.current !== fitKey && bars.length > 0) {
      fitKeyRef.current = fitKey
      chartRef.current?.timeScale().fitContent()
    }
  }, [bars, maFastData, maSlowData, pair, interval])

  const legendBar = legend?.bar
  const legendUp = legendBar ? legendBar.close >= legendBar.open : true
  const legendChange =
    legendBar && legendBar.open > 0 ? ((legendBar.close - legendBar.open) / legendBar.open) * 100 : 0

  return (
    <div className="kline-wrap">
      <div className="kline-head">
        <div className="kline-legend" data-testid="kline-legend">
          {legendBar ? (
            <>
              <span className="kline-legend-time">{fmtChartTime(legendBar.time)}</span>
              <span>开 <b>{fmtPrice(legendBar.open)}</b></span>
              <span>高 <b>{fmtPrice(legendBar.high)}</b></span>
              <span>低 <b>{fmtPrice(legendBar.low)}</b></span>
              <span>
                收{' '}
                <b style={{ color: legendUp ? CHART_UP : CHART_DOWN }}>{fmtPrice(legendBar.close)}</b>
              </span>
              <span style={{ color: legendUp ? CHART_UP : CHART_DOWN }}>
                {legendChange >= 0 ? '+' : ''}
                {legendChange.toFixed(2)}%
              </span>
              <span>量 <b>{fmtTotal(legendBar.volume)}</b></span>
              {legend?.maFast != null && (
                <span style={{ color: MA_FAST }}>MA{MA_FAST_PERIOD} <b>{fmtPrice(legend.maFast)}</b></span>
              )}
              {legend?.maSlow != null && (
                <span style={{ color: MA_SLOW }}>MA{MA_SLOW_PERIOD} <b>{fmtPrice(legend.maSlow)}</b></span>
              )}
            </>
          ) : (
            <span className="kline-legend-time">K 线 · {pair}</span>
          )}
        </div>
        <div className="kline-tabs" role="tablist" aria-label="K 线周期">
          {INTERVALS.map((it) => (
            <button
              key={it.value}
              type="button"
              role="tab"
              aria-selected={interval === it.value}
              className={`kline-tab${interval === it.value ? ' kline-tab-active' : ''}`}
              onClick={() => setIntervalValue(it.value)}
            >
              {it.label}
            </button>
          ))}
        </div>
      </div>
      <div className="kline-stage">
        <div ref={containerRef} style={{ width: '100%' }} />
        {loading && (
          <div className="kline-overlay">
            <Text size="xs" c="dimmed">K 线加载中…</Text>
          </div>
        )}
        {!loading && error && (
          <div className="kline-overlay">
            <Text size="xs" c="red">K 线加载失败：{error}</Text>
          </div>
        )}
        {!loading && !error && bars.length === 0 && (
          <div className="kline-overlay">
            <Text size="xs" c="dimmed">暂无成交数据 · 有成交后自动生成 K 线</Text>
          </div>
        )}
      </div>
    </div>
  )
}
