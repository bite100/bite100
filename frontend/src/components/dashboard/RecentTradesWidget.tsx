import { useEffect, useState } from 'react'
import { Text } from '@mantine/core'
import { nodeGet } from '../../nodeClient'

const DEFAULT_PAIR = 'TKA/TKB'
const DISPLAY_LIMIT = 18

interface RecentTrade {
  tradeId: string
  price: number
  amount: number
  timestamp: number
}

/**
 * 右栏「最新成交」：与订单簿同源（节点 /api/trades），5 秒轮询。
 * 价格颜色按与上一笔（更早）成交的比较着色——成交记录本身不带 taker 方向字段，不臆造方向。
 */
export function RecentTradesWidget() {
  const [trades, setTrades] = useState<RecentTrade[]>([])
  const [loading, setLoading] = useState(true)
  /** 节点不可达/未配置时为 true，区分「暂无成交」与「节点未连接」 */
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const fetchTrades = async () => {
      try {
        const { data } = await nodeGet<unknown>('/api/trades', {
          pair: DEFAULT_PAIR,
          limit: '30',
        })
        if (cancelled) return
        const list = Array.isArray(data) ? data : []
        const normalized: RecentTrade[] = list
          .map((t: unknown) => {
            const o: Record<string, unknown> =
              t && typeof t === 'object' ? (t as Record<string, unknown>) : {}
            return {
              tradeId: String(o.tradeId ?? o.TradeID ?? ''),
              price: Number(o.price ?? 0),
              amount: Number(o.amount ?? 0),
              timestamp: Number(o.timestamp ?? 0),
            }
          })
          .filter((t) => t.price > 0)
          .sort((a, b) => b.timestamp - a.timestamp)
        setTrades(normalized.slice(0, DISPLAY_LIMIT))
        setFailed(false)
      } catch {
        if (!cancelled) {
          setTrades([])
          setFailed(true)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchTrades()
    const t = setInterval(fetchTrades, 5000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  const [base, quote] = DEFAULT_PAIR.split('/')

  return (
    <div className="recent-trades">
      <div className="book-head">
        <Text size="sm" fw={600}>
          最新成交
        </Text>
        <Text size="xs" c="dimmed">{DEFAULT_PAIR}</Text>
      </div>
      <div className="book-cols" aria-hidden>
        <span>价格 ({quote})</span>
        <span>数量 ({base})</span>
        <span>时间</span>
      </div>
      {loading ? (
        <Text size="xs" c="dimmed" py="sm">加载中…</Text>
      ) : trades.length === 0 ? (
        <Text size="xs" c="dimmed" py={4}>
          {failed ? '节点未连接，暂无成交数据' : '暂无成交'}
        </Text>
      ) : (
        trades.map((t, i) => {
          const older = trades[i + 1]
          const color =
            !older || t.price === older.price
              ? 'var(--b100-text)'
              : t.price > older.price
                ? 'var(--b100-up)'
                : 'var(--b100-down)'
          return (
            <div className="book-row book-row-static" key={t.tradeId || `${t.timestamp}-${i}`}>
              <span className="book-cell book-price" style={{ color }}>
                {t.price.toFixed(4)}
              </span>
              <span className="book-cell book-cell-r">{t.amount.toFixed(4)}</span>
              <span className="book-cell book-cell-r">
                {t.timestamp > 0 ? new Date(t.timestamp * 1000).toLocaleTimeString() : '—'}
              </span>
            </div>
          )
        })
      )}
    </div>
  )
}
