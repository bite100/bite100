import { useEffect, useState } from 'react'
import { Text } from '@mantine/core'
import { CHAIN_ID } from '../../config'
import { DEFAULT_PAIR } from '../../config/pairs'
import { createRelayBookAdapter } from '../../services/dualread/adapters'
import { fromScaled, toPlain, fmtPrice, fmtAmount, fmtTotal } from './tradeFormat'

/** 右栏盘口每侧展示档位数（对标 HY 右栏密度） */
const DISPLAY_DEPTH = 10

export interface OrderBookRow {
  /** 人类单位（非 wei）十进制字符串——marketOrder.ts 注明的既有口径 */
  price: string
  amount: string
  side: 'buy' | 'sell'
}

export interface OrderBookWidgetProps {
  /** 第二十五轮：当前交易对（由交易台传入，随 URL ?pair= 切换） */
  pair?: string
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

/**
 * 订单簿（第 28 轮视觉重做，排版基准见 docs/round28-chart-orderbook-ui-2026-11-08.md）：
 * 卖盘倒序、价差居中行、深度条按累计量比例（浅底淡色）、价格涨跌语义色、
 * 等宽数字右对齐。数据第 51 轮（阶段 5 节点退役）改读订单中继簿
 * （createRelayBookAdapter，自带 10 秒超时）；中继返回的定点/wei 在此
 * 换算为人类单位（展示层换算，数据口径不变）；本组件对外
 * （onBookUpdate/onPriceClick）一律人类单位，与 marketOrder.ts 的既有
 * 约定一致。
 */
export function OrderBookWidget({ pair = DEFAULT_PAIR, onBookUpdate, onPriceClick }: OrderBookWidgetProps = {}) {
  const [bids, setBids] = useState<OrderBookRow[]>([])
  const [asks, setAsks] = useState<OrderBookRow[]>([])
  const [loading, setLoading] = useState(true)
  /** 中继不可达/未配置时为 true，用于把「无盘口」与「中继未连接」两种空态区分开 */
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const adapter = createRelayBookAdapter()
    const fetchBook = async () => {
      try {
        const book = await adapter.fetchBook(CHAIN_ID, pair)
        if (cancelled) return
        const toRow = (o: { price: string; amount: string }, side: 'buy' | 'sell'): OrderBookRow => ({
          price: toPlain(fromScaled(o.price)),
          amount: toPlain(fromScaled(o.amount)),
          side,
        })
        const newBids = book.bids.slice(0, 15).map((o) => toRow(o, 'buy'))
        const newAsks = book.asks.slice(0, 15).map((o) => toRow(o, 'sell'))
        setBids(newBids)
        setAsks(newAsks)
        setFailed(false)
        onBookUpdate?.(newBids, newAsks)
      } catch {
        if (!cancelled) {
          setBids([])
          setAsks([])
          setFailed(true)
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
  }, [pair, onBookUpdate])

  const [base, quote] = pair.split('/')
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
          {fmtPrice(Number(level.price))}
        </span>
        <span className="book-cell book-cell-r">{fmtAmount(Number(level.amount))}</span>
        <span className="book-cell book-cell-r">{fmtTotal(level.total)}</span>
      </button>
    )
  }

  return (
    <div className="book-wrap">
      <div className="book-head">
        <Text size="sm" fw={600}>
          订单簿
        </Text>
        <Text size="xs" c="dimmed">{pair}</Text>
      </div>
      <div className="book-cols" aria-hidden>
        <span>价格 ({quote})</span>
        <span>数量 ({base})</span>
        <span>累计 ({base})</span>
      </div>
      {loading ? (
        <Text size="xs" c="dimmed" py="sm">加载中…</Text>
      ) : failed && bids.length === 0 && asks.length === 0 ? (
        <Text size="xs" c="dimmed" py="sm">
          中继服务暂时不可用，盘口无法加载（资产与跨链不受影响）
        </Text>
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
                <span className="book-spread-mid">{fmtPrice(mid)}</span>
                <span className="book-spread-val">
                  价差 {fmtPrice(spread)}
                  {!Number.isNaN(spreadPct) && ` (${spreadPct.toFixed(2)}%)`}
                </span>
              </>
            ) : (
              <span className="book-spread-val">暂无盘口数据</span>
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
