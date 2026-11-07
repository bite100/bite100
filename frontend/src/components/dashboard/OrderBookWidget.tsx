import { useEffect, useState } from 'react'
import { Text } from '@mantine/core'
import { nodeGet } from '../../nodeClient'

const DEFAULT_PAIR = 'TKA/TKB'
/** 右栏盘口每侧展示档位数（对标 HY 右栏密度） */
const DISPLAY_DEPTH = 10

export interface OrderBookRow {
  price: string
  amount: string
  side: 'buy' | 'sell'
}

export interface OrderBookWidgetProps {
  /** 订单簿更新时回调，用于计算 mid 等 */
  onBookUpdate?: (bids: OrderBookRow[], asks: OrderBookRow[]) => void
  /** 点击某一档价格时回调，用于把价格带入下单面板 */
  onPriceClick?: (price: string) => void
}

interface BookLevel extends OrderBookRow {
  total: number
}

/** 在最佳档一侧向外累加数量，得到累计深度 */
function withTotals(rows: OrderBookRow[]): BookLevel[] {
  let acc = 0
  return rows.map((r) => {
    acc += Number(r.amount) || 0
    return { ...r, total: acc }
  })
}

export function OrderBookWidget({ onBookUpdate, onPriceClick }: OrderBookWidgetProps = {}) {
  const [bids, setBids] = useState<OrderBookRow[]>([])
  const [asks, setAsks] = useState<OrderBookRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const fetchBook = async () => {
      try {
        const { data } = await nodeGet<{ pair: string; bids: Array<{ price: string; amount: string }>; asks: Array<{ price: string; amount: string }> }>(
          '/api/orderbook',
          { pair: DEFAULT_PAIR }
        )
        if (cancelled) return
        const newBids = (data.bids ?? []).slice(0, 15).map((o) => ({ price: o.price, amount: o.amount, side: 'buy' as const }))
        const newAsks = (data.asks ?? []).slice(0, 15).map((o) => ({ price: o.price, amount: o.amount, side: 'sell' as const }))
        setBids(newBids)
        setAsks(newAsks)
        onBookUpdate?.(newBids, newAsks)
      } catch {
        if (!cancelled) {
          setBids([])
          setAsks([])
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchBook()
    const t = setInterval(fetchBook, 5000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [onBookUpdate])

  const [base, quote] = DEFAULT_PAIR.split('/')
  const askLevels = withTotals(asks.slice(0, DISPLAY_DEPTH))
  const bidLevels = withTotals(bids.slice(0, DISPLAY_DEPTH))
  // 卖盘展示时最佳卖价贴近价差行：数组本身最佳档在前，渲染时反转为高价在上
  const askDisplay = [...askLevels].reverse()
  const maxTotal = Math.max(
    askLevels.length ? askLevels[askLevels.length - 1].total : 0,
    bidLevels.length ? bidLevels[bidLevels.length - 1].total : 0,
    0
  )
  const bestBid = bids.length ? Number(bids[0].price) : NaN
  const bestAsk = asks.length ? Number(asks[0].price) : NaN
  const hasSpread = !Number.isNaN(bestBid) && !Number.isNaN(bestAsk) && bestBid > 0 && bestAsk > 0
  const mid = hasSpread ? (bestBid + bestAsk) / 2 : NaN
  const spread = hasSpread ? bestAsk - bestBid : NaN
  const spreadPct = hasSpread && mid > 0 ? (spread / mid) * 100 : NaN

  const renderRow = (level: BookLevel, kind: 'ask' | 'bid') => {
    const depthPct = maxTotal > 0 ? Math.min(100, (level.total / maxTotal) * 100) : 0
    return (
      <button
        type="button"
        key={`${kind}-${level.price}-${level.total}`}
        className={`book-row book-row-${kind}`}
        onClick={() => onPriceClick?.(level.price)}
        title="点击将价格带入下单面板"
      >
        <span
          className={`book-depth ${kind === 'ask' ? 'book-depth-ask' : 'book-depth-bid'}`}
          style={{ width: `${depthPct}%` }}
        />
        <span className="book-cell book-price" style={{ color: kind === 'ask' ? 'var(--b100-down)' : 'var(--b100-up)' }}>
          {Number(level.price).toFixed(4)}
        </span>
        <span className="book-cell book-cell-r">{Number(level.amount).toFixed(4)}</span>
        <span className="book-cell book-cell-r">{level.total.toFixed(4)}</span>
      </button>
    )
  }

  return (
    <div className="book-wrap">
      <div className="book-head">
        <Text size="sm" fw={600}>
          订单簿
        </Text>
        <Text size="xs" c="dimmed">{DEFAULT_PAIR}</Text>
      </div>
      <div className="book-cols" aria-hidden>
        <span>价格 ({quote})</span>
        <span>数量 ({base})</span>
        <span>累计 ({base})</span>
      </div>
      {loading ? (
        <Text size="xs" c="dimmed" py="sm">加载中…</Text>
      ) : (
        <>
          <div className="book-side">
            {askDisplay.length === 0 ? (
              <Text size="xs" c="dimmed" py={4}>暂无卖盘</Text>
            ) : (
              askDisplay.map((l) => renderRow(l, 'ask'))
            )}
          </div>
          <div className="book-spread">
            {hasSpread ? (
              <>
                <span className="book-spread-mid">{mid.toFixed(4)}</span>
                <span className="book-spread-val">
                  价差 {spread.toFixed(4)}
                  {!Number.isNaN(spreadPct) && ` (${spreadPct.toFixed(2)}%)`}
                </span>
              </>
            ) : (
              <span className="book-spread-val">暂无盘口</span>
            )}
          </div>
          <div className="book-side">
            {bidLevels.length === 0 ? (
              <Text size="xs" c="dimmed" py={4}>暂无买盘</Text>
            ) : (
              bidLevels.map((l) => renderRow(l, 'bid'))
            )}
          </div>
        </>
      )}
    </div>
  )
}
