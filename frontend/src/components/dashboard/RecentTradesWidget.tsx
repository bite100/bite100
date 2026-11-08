import { useEffect, useState } from 'react'
import { Text } from '@mantine/core'
import { nodeGet } from '../../nodeClient'
import { CHAIN_ID } from '../../config'
import { DEFAULT_PAIR, getPairTokens } from '../../config/pairs'
import { INDEXER_ENABLED } from '../../config/indexer'
import {
  fetchIndexerTrades,
  loadDualTrades,
  type MergedTrade,
  type NodeTrade,
} from '../../services/tradesDual'
import { fromScaled, fmtPrice, fmtAmount, fmtTime } from './tradeFormat'

const DISPLAY_LIMIT = 18

interface RecentTrade {
  tradeId: string
  price: number
  amount: number
  timestamp: number
}

export interface RecentTradesWidgetProps {
  /** 第二十五轮：当前交易对（由交易台传入，随 URL ?pair= 切换） */
  pair?: string
}

/**
 * 右栏「最新成交」：与订单簿同源（节点 /api/trades），5 秒轮询。
 * 价格颜色按与上一笔（更早）成交的比较着色——成交记录本身不带 taker 方向字段，不臆造方向。
 *
 * 第 34 轮双源：配置 VITE_INDEXER_URL 后，Envio 链上索引为权威展示源——
 * 与节点按 (chainId, txHash, logIndex) 口径合并（节点无 logIndex，同 tx 内
 * 按双方+数量配对），节点独有标「待索引」，Envio 独有照常展示，冲突以链上
 * 事件为准（见 services/tradesDual.ts）。未配置时行为与此前完全一致。
 *
 * 第 35 轮 D6：双源独立取数——节点宕机时照常展示链上索引数据（页首会
 * 明示「节点暂不可达」），索引宕机时回退节点数据；两源皆不可达才显示
 * 「成交数据暂不可用」，不再把单源故障误报成整页不可用。
 */
export function RecentTradesWidget({ pair = DEFAULT_PAIR }: RecentTradesWidgetProps = {}) {
  const [trades, setTrades] = useState<RecentTrade[]>([])
  const [merged, setMerged] = useState<MergedTrade[] | null>(null)
  const [indexerFailed, setIndexerFailed] = useState(false)
  /** 第 35 轮 D6：节点源单独失败标记（索引可用时不再整页盖掉） */
  const [nodeFailed, setNodeFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  /** 无任一数据源可用时为 true，区分「暂无成交」与「数据不可用」 */
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const fetchTrades = async () => {
      if (INDEXER_ENABLED) {
        // 第 35 轮 D6：两源独立取数（loadDualTrades 内部 allSettled），
        // 任一源失败只降级该源；两源皆失败才置 failed（不可用态）。
        const baseToken = getPairTokens(CHAIN_ID, pair)?.base ?? ''
        const outcome = await loadDualTrades(
          async () => {
            const { data } = await nodeGet<unknown>('/api/trades', {
              pair,
              limit: '30',
            })
            const list = Array.isArray(data) ? data : []
            return list.map((t: unknown): NodeTrade => {
              const o: Record<string, unknown> =
                t && typeof t === 'object' ? (t as Record<string, unknown>) : {}
              return {
                tradeId: String(o.tradeId ?? o.TradeID ?? ''),
                txHash: String(o.txHash ?? ''),
                maker: String(o.maker ?? ''),
                taker: String(o.taker ?? ''),
                tokenIn: String(o.tokenIn ?? ''),
                tokenOut: String(o.tokenOut ?? ''),
                amountIn: String(o.amountIn ?? '0'),
                amountOut: String(o.amountOut ?? '0'),
                price: String(o.price ?? '0'),
                amount: String(o.amount ?? '0'),
                timestamp: Number(o.timestamp ?? 0),
              }
            })
          },
          () => fetchIndexerTrades(CHAIN_ID, pair, 50),
          baseToken,
        )
        if (cancelled) return
        setNodeFailed(outcome.nodeFailed)
        setIndexerFailed(outcome.indexerFailed)
        setFailed(outcome.unavailable)
        setMerged(outcome.result.trades.filter((t) => t.price > 0).slice(0, DISPLAY_LIMIT))
        setLoading(false)
        return
      }
      try {
        const { data } = await nodeGet<unknown>('/api/trades', {
          pair,
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
              price: fromScaled(o.price),
              amount: fromScaled(o.amount),
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
          setMerged(null)
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
  }, [pair])

  const [base, quote] = pair.split('/')
  const displayMerged = INDEXER_ENABLED ? (merged ?? []) : null

  return (
    <div className="recent-trades">
      <div className="book-head">
        <Text size="sm" fw={600}>
          最新成交
        </Text>
        <Text size="xs" c="dimmed">{pair}</Text>
      </div>
      {INDEXER_ENABLED && (
        <Text size="xs" c="dimmed">
          {nodeFailed && indexerFailed
            ? '节点与链上索引均不可达，成交数据暂不可用'
            : indexerFailed
              ? '链上索引暂不可达，暂显示节点数据（均标「待索引」）'
              : nodeFailed
                ? '节点暂不可达，暂显示链上索引数据（Envio 为权威来源）'
                : '来源：链上索引（Envio）为权威，节点独有成交标「待索引」'}
        </Text>
      )}
      <div className="book-cols" aria-hidden>
        <span>价格 ({quote})</span>
        <span>数量 ({base})</span>
        <span>时间</span>
      </div>
      {loading ? (
        <Text size="xs" c="dimmed" py="sm">加载中…</Text>
      ) : displayMerged ? (
        displayMerged.length === 0 ? (
          <Text size="xs" c="dimmed" py={4}>
            {failed ? '节点与链上索引均不可达，成交数据暂不可用' : '暂无成交'}
          </Text>
        ) : (
          displayMerged.map((t, i) => {
            const older = displayMerged[i + 1]
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
                  {t.timestamp > 0 ? fmtTime(t.timestamp) : '—'}
                  {t.pendingIndex ? ' · 待索引' : t.source === 'envio' ? ' · 链上' : ''}
                </span>
              </div>
            )
          })
        )
      ) : trades.length === 0 ? (
        <Text size="xs" c="dimmed" py={4}>
          {failed ? '节点未连接，成交数据暂不可用' : '暂无成交'}
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
                {fmtPrice(t.price)}
              </span>
              <span className="book-cell book-cell-r">{fmtAmount(t.amount)}</span>
              <span className="book-cell book-cell-r">
                {t.timestamp > 0 ? fmtTime(t.timestamp) : '—'}
              </span>
            </div>
          )
        })
      )}
    </div>
  )
}
