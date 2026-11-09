import { useEffect, useState } from 'react'
import { Text } from '@mantine/core'
import { CHAIN_ID } from '../../config'
import { DEFAULT_PAIR } from '../../config/pairs'
import { INDEXER_ENABLED } from '../../config/indexer'
import { loadIndexerTrades, type DisplayTrade } from '../../services/tradesDual'
import { fmtPrice, fmtAmount, fmtTime } from './tradeFormat'

const DISPLAY_LIMIT = 18

export interface RecentTradesWidgetProps {
  /** 第二十五轮：当前交易对（由交易台传入，随 URL ?pair= 切换） */
  pair?: string
}

/**
 * 右栏「最新成交」：链上索引（Envio Trade 事件）单源，5 秒轮询。
 * 价格颜色按与上一笔（更早）成交的比较着色——成交记录本身不带 taker
 * 方向字段，不臆造方向。
 *
 * 第 34–39 轮曾为「节点 + 索引」双源合并（节点独有标「待索引」、冲突
 * 以链上为准、双源各自超时）；第 51 轮（阶段 5 节点退役）节点源删除，
 * 只剩链上索引：索引是链上事件的展示缓存（Ren 口径：链是唯一账本），
 * 索引不可达/未配置时如实显示「暂不可用」，不拿空数据冒充「暂无成交」。
 * 取数超时（8 秒）与轮询 in-flight 守卫沿用第 39 轮纪律。
 */
export function RecentTradesWidget({ pair = DEFAULT_PAIR }: RecentTradesWidgetProps = {}) {
  const [trades, setTrades] = useState<DisplayTrade[]>([])
  const [loading, setLoading] = useState(true)
  /** 索引取数失败时为 true，区分「暂无成交」与「数据不可用」 */
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    // 第 39 轮：in-flight 守卫——上一轮取数未完成时跳过本轮 tick，避免
    // 慢/挂死请求在 5 秒轮询下叠加（取数已有超时兜底，此处再防堆积）。
    let inFlight = false
    const fetchTrades = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const outcome = await loadIndexerTrades(CHAIN_ID, pair, 50)
        if (cancelled) return
        setFailed(outcome.failed)
        setTrades(outcome.trades.filter((t) => t.price > 0).slice(0, DISPLAY_LIMIT))
        setLoading(false)
      } finally {
        inFlight = false
      }
    }
    fetchTrades()
    const t = setInterval(fetchTrades, 5000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [pair])

  const [base, quote] = pair.split('/')

  return (
    <div className="recent-trades">
      <div className="book-head">
        <Text size="sm" fw={600}>
          最新成交
        </Text>
        <Text size="xs" c="dimmed">{pair}</Text>
      </div>
      <Text size="xs" c="dimmed">
        {!INDEXER_ENABLED
          ? '链上索引未配置，成交记录暂不可用'
          : failed
            ? '链上索引暂不可达，成交数据暂不可用'
            : '来源：链上索引（Envio），成交以链上事件为准'}
      </Text>
      <div className="book-cols" aria-hidden>
        <span>价格 ({quote})</span>
        <span>数量 ({base})</span>
        <span>时间</span>
      </div>
      {loading ? (
        <Text size="xs" c="dimmed" py="sm">加载中…</Text>
      ) : trades.length === 0 ? (
        <Text size="xs" c="dimmed" py={4}>
          {failed || !INDEXER_ENABLED ? '成交数据暂不可用' : '暂无成交'}
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
            <div className="book-row book-row-static" key={t.key}>
              <span className="book-cell book-price" style={{ color }}>
                {fmtPrice(t.price)}
              </span>
              <span className="book-cell book-cell-r">{fmtAmount(t.amount)}</span>
              <span className="book-cell book-cell-r">
                {t.timestamp > 0 ? fmtTime(t.timestamp) : '—'} · 链上
              </span>
            </div>
          )
        })
      )}
    </div>
  )
}
