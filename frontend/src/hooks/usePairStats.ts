/**
 * 交易对顶部信息条统计：全部由成交数据推导，不引入外部行情源。
 * 数据源第 51 轮（阶段 5 节点退役）由节点 /api/trades 改为链上索引
 * （loadIndexerTrades，Envio Trade 事件，价格/数量已是人类单位）——
 * 聚合口径不变（无节点设计 §5：前端聚合保留，只换数据入口）。
 * - 最新价：最近一笔成交价
 * - 24h 涨跌：最新价 vs 24h 窗口起点参考价（窗口前最后一笔成交价；无则取窗口内最早一笔）
 * - 24h 最高/最低/成交量：窗口内成交的价格极值与数量合计（基础币 TKA / 计价币 TKB）
 * 无成交数据时各字段为 null，由 UI 显示占位符。
 */
import { useEffect, useState } from 'react'
import { CHAIN_ID } from '../config'
import { loadIndexerTrades } from '../services/tradesDual'

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
      const outcome = await loadIndexerTrades(CHAIN_ID, pair, TRADES_LIMIT)
      if (cancelled) return
      if (outcome.failed) {
        setStats(EMPTY)
        return
      }
      // 索引展示行价格/数量已是人类单位，直接进既有聚合口径
      const normalized: NormTrade[] = outcome.trades.map((t) => ({
        price: t.price,
        amount: t.amount,
        timestamp: t.timestamp,
      }))
      setStats(computeStats(normalized))
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
