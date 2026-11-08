/**
 * 紧凑盘口（第 31 轮，移动交易页左列）：卖 5 档（红，累计深度条）在上、
 * 大号最新价 + Chainlink 参考价小字居中、买 5 档在下、买卖强度条、精度选择行。
 * 与桌面 OrderBookWidget 同源（useOrderBook），点档位把价格带入下单票。
 * 参考价小字只在 Chainlink 喂价可用（source=chainlink）时显示，口径同行情页。
 */
import { useMemo, useState } from 'react'
import type { OrderBookRow } from './OrderBookWidget'
import { aggregateLevels, powerBarPct, stepOptionsFor, type BookLevelIn } from './depthAggregate'
import { fmtPrice, fmtAmount } from './tradeFormat'
import './CompactBook.css'

interface CompactBookProps {
  pair: string
  bids: OrderBookRow[]
  asks: OrderBookRow[]
  loading: boolean
  failed: boolean
  lastPrice: number | null
  changePct: number | null
  /** Chainlink 参考价（仅喂价可用时传入，否则 null 不显示） */
  refPrice: number | null
  onPriceClick: (price: string) => void
}

type DisplayMode = 'both' | 'bids' | 'asks'

const toLevels = (rows: OrderBookRow[]): BookLevelIn[] =>
  rows.map((r) => ({ price: Number(r.price), amount: Number(r.amount) }))

export function CompactBook({
  pair,
  bids,
  asks,
  loading,
  failed,
  lastPrice,
  changePct,
  refPrice,
  onPriceClick,
}: CompactBookProps) {
  const [base, quote] = pair.split('/')
  const steps = useMemo(() => stepOptionsFor(lastPrice), [lastPrice])
  const [step, setStep] = useState<number | null>(null)
  const [mode, setMode] = useState<DisplayMode>('both')
  const [showTotal, setShowTotal] = useState(false)
  const activeStep = step ?? steps[Math.min(2, steps.length - 1)] ?? 0

  const aggBids = useMemo(() => aggregateLevels(toLevels(bids), activeStep, 'buy'), [bids, activeStep])
  const aggAsks = useMemo(() => aggregateLevels(toLevels(asks), activeStep, 'sell'), [asks, activeStep])
  const perSide = mode === 'both' ? 5 : 10
  const shownBids = aggBids.slice(0, perSide)
  const shownAsks = aggAsks.slice(0, perSide)
  const power = useMemo(
    () => powerBarPct(aggBids.slice(0, 10), aggAsks.slice(0, 10)),
    [aggBids, aggAsks],
  )
  const maxShownTotal = Math.max(
    shownBids.length ? shownBids[shownBids.length - 1].total : 0,
    shownAsks.length ? shownAsks[shownAsks.length - 1].total : 0,
    0,
  )

  const renderRow = (l: { price: number; amount: number; total: number }, kind: 'ask' | 'bid') => {
    const depthPct = maxShownTotal > 0 ? Math.min(100, (l.total / maxShownTotal) * 100) : 0
    return (
      <button
        type="button"
        key={`${kind}-${l.price}`}
        className="cbook-row"
        onClick={() => onPriceClick(String(l.price))}
        title="点击将价格带入下单面板"
      >
        <span className={`cbook-depth ${kind === 'ask' ? 'ask' : 'bid'}`} style={{ width: `${depthPct}%` }} />
        <span className="cbook-price num" style={{ color: kind === 'ask' ? 'var(--b100-down)' : 'var(--b100-up)' }}>
          {fmtPrice(l.price)}
        </span>
        <span className="cbook-amt num">{showTotal ? fmtAmount(l.total) : fmtAmount(l.amount)}</span>
      </button>
    )
  }

  const priceColor =
    changePct == null ? 'var(--b100-text)' : changePct >= 0 ? 'var(--b100-up)' : 'var(--b100-down)'

  return (
    <div className="cbook">
      <div className="cbook-head">
        <span>
          价格<small>({quote})</small>
        </span>
        <button
          type="button"
          className="cbook-coltoggle"
          onClick={() => setShowTotal((v) => !v)}
          title="切换数量 / 累计"
        >
          {showTotal ? '累计' : '数量'}
          <small>({base})</small> ⇅
        </button>
      </div>
      {loading ? (
        <p className="cbook-empty">加载中…</p>
      ) : failed && bids.length === 0 && asks.length === 0 ? (
        <p className="cbook-empty">节点服务暂时不可用，盘口无法加载（资产与跨链不受影响）</p>
      ) : (
        <>
          {mode !== 'bids' && (
            <div className="cbook-side">
              {shownAsks.length === 0 ? (
                <p className="cbook-none">暂无卖盘</p>
              ) : (
                [...shownAsks].reverse().map((l) => renderRow(l, 'ask'))
              )}
            </div>
          )}
          <div className="cbook-mid">
            {lastPrice != null ? (
              <>
                <span className="cbook-last num" style={{ color: priceColor }}>
                  {fmtPrice(lastPrice)} {changePct != null && (changePct >= 0 ? '↑' : '↓')}
                </span>
                {quote === 'USDT' && <span className="cbook-usd num">≈ ${fmtPrice(lastPrice)}</span>}
                {refPrice != null && (
                  <span className="cbook-ref num">
                    参考价（Chainlink）{fmtPrice(refPrice)}
                  </span>
                )}
              </>
            ) : (
              <span className="cbook-last cbook-last-none">暂无成交</span>
            )}
          </div>
          {mode !== 'asks' && (
            <div className="cbook-side">
              {shownBids.length === 0 ? (
                <p className="cbook-none">暂无买盘</p>
              ) : (
                shownBids.map((l) => renderRow(l, 'bid'))
              )}
            </div>
          )}
          {power && mode === 'both' && (
            <div className="cbook-power" aria-label={`买盘强度 ${power.buyPct}%`}>
              <span className="cbook-power-b num" style={{ width: `${power.buyPct}%` }}>
                B {power.buyPct}%
              </span>
              <span className="cbook-power-s num" style={{ width: `${power.sellPct}%` }}>
                {power.sellPct}% S
              </span>
            </div>
          )}
          <div className="cbook-foot">
            <label className="cbook-step">
              <select
                value={String(activeStep)}
                onChange={(e) => setStep(Number(e.target.value))}
                aria-label="盘口精度"
              >
                {steps.map((s) => (
                  <option key={s} value={String(s)}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="cbook-mode"
              onClick={() => setMode((m) => (m === 'both' ? 'bids' : m === 'bids' ? 'asks' : 'both'))}
              title="切换盘口显示：双边 / 只看买盘 / 只看卖盘"
              aria-label="切换盘口显示模式"
            >
              {mode === 'both' ? '▦' : mode === 'bids' ? '▤' : '▥'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
