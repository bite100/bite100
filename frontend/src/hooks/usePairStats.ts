/**
 * 交易对顶部信息条统计：全部由节点 /api/trades 现有成交数据推导，不引入外部行情源。
 * - 最新价：最近一笔成交价
 * - 24h 涨跌：最新价 vs 24h 窗口起点参考价（窗口前最后一笔成交价；无则取窗口内最早一笔）
 * - 24h 最高/最低/成交量：窗口内成交的价格极值与数量合计（基础币 TKA / 计价币 TKB）
 * 无成交数据时各字段为 null，由 UI 显示占位符。
 */
import { useEffect, useState } from 'react'
import { nodeGet } from '../nodeClient'

const DEFAULT_PAIR = 'TKA/TKB'
const TRADES_LIMIT = 500
const DAY_SEC = 86400
const POLL_MS = 15000

export interface PairStats {
  lastPrice: number | null
  /** 最近一笔成交的时间（unix 秒）；无成交为 null（第二十三轮参考价兜底标注用） */
  lastTradeAt: number | null
  change24hPct: number | null
  high24h: number | null
  low24h: number | null
  /** 24h 成交量（基础币 TKA） */
  volume24hBase: number | null
  /** 24h 成交额（计价币 TKB） */
  volume24hQuote: number | null
}

const EMPTY: PairStats = {
  lastPrice: null,
  lastTradeAt: null,
  change24hPct: null,
  high24h: null,
  low24h: null,
  volume24hBase: null,
  volume24hQuote: null,
}

interface NormTrade {
  price: number
  amount: number
  timestamp: number
}

function computeStats(trades: NormTrade[]): PairStats {
  const valid = trades
    .filter((t) => t.price > 0 && t.timestamp > 0)
    .sort((a, b) => a.timestamp - b.timestamp)
  if (valid.length === 0) return EMPTY

  const last = valid[valid.length - 1]
  const lastPrice = last.price
  const windowStart = last.timestamp - DAY_SEC
  const inWindow = valid.filter((t) => t.timestamp >= windowStart)
  const windowTrades = inWindow.length > 0 ? inWindow : [last]

  let high = -Infinity
  let low = Infinity
  let volBase = 0
  let volQuote = 0
  for (const t of windowTrades) {
    high = Math.max(high, t.price)
    low = Math.min(low, t.price)
    volBase += t.amount
    volQuote += t.amount * t.price
  }

  // 24h 参考价：窗口起点之前最后一笔成交价；不存在时用窗口内最早一笔
  let ref: number | null = null
  for (let i = valid.length - 1; i >= 0; i--) {
    if (valid[i].timestamp <= windowStart) {
      ref = valid[i].price
      break
    }
  }
  if (ref == null) ref = windowTrades[0].price
  const change24hPct = ref > 0 ? ((lastPrice - ref) / ref) * 100 : null

  return {
    lastPrice,
    lastTradeAt: last.timestamp,
    change24hPct,
    high24h: high === -Infinity ? null : high,
    low24h: low === Infinity ? null : low,
    volume24hBase: volBase,
    volume24hQuote: volQuote,
  }
}

export function usePairStats(pair: string = DEFAULT_PAIR): PairStats {
  const [stats, setStats] = useState<PairStats>(EMPTY)

  useEffect(() => {
    let cancelled = false
    const fetchStats = async () => {
      try {
        const { data } = await nodeGet<unknown>('/api/trades', {
          pair,
          limit: String(TRADES_LIMIT),
        })
        if (cancelled) return
        const list = Array.isArray(data) ? data : []
        const normalized: NormTrade[] = list.map((t: unknown) => {
          const o: Record<string, unknown> =
            t && typeof t === 'object' ? (t as Record<string, unknown>) : {}
          return {
            price: Number(o.price ?? 0),
            amount: Number(o.amount ?? 0),
            timestamp: Number(o.timestamp ?? 0),
          }
        })
        setStats(computeStats(normalized))
      } catch {
        if (!cancelled) setStats(EMPTY)
      }
    }
    fetchStats()
    const timer = setInterval(fetchStats, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [pair])

  return stats
}
