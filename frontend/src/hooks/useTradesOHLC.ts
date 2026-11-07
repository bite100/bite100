/**
 * 从节点 /api/trades 拉取成交并聚合成 OHLC K 线（供 KLineChart 使用）
 * 可选：通过 p2pWS 订阅 trade 实时追加/更新最后一根 K 线
 *
 * 单位（第 28 轮）：节点 price 为 1e18 定点、amount 为 wei，本 hook 在归一化
 * 时统一经 fromScaled 换算为人类单位，并按 bar 累加成交量（base 数量合计）。
 * 数据源与聚合口径不变——仍是同一份 /api/trades 成交。
 */
import { useState, useEffect, useCallback } from 'react'
import { nodeGet } from '../nodeClient'
import { p2pWS } from '../services/wsClient'
import { fromScaled } from '../components/dashboard/tradeFormat'

const DEFAULT_PAIR = 'TKA/TKB'
const BAR_INTERVAL_SEC = 3600 // 1 小时一根 K 线
const TRADES_LIMIT = 500

export interface TradeRecord {
  tradeId?: string
  pair?: string
  /** 人类单位价格（已从节点定点换算） */
  price: number
  /** 人类单位数量（已从 wei 换算） */
  amount: number
  timestamp: number
}

export interface OHLCBar {
  time: number
  open: number
  high: number
  low: number
  close: number
  /** 本 bar 成交量（base 人类单位合计） */
  volume: number
}

/** 把节点原始成交（定点/wei 字符串）归一化为人类单位记录；不可解析的价格记为 NaN 由聚合层过滤 */
export function normalizeTrade(raw: unknown): TradeRecord {
  const o: Record<string, unknown> =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    tradeId: String(o.tradeId ?? o.TradeID ?? ''),
    pair: String(o.pair ?? ''),
    price: fromScaled(o.price),
    amount: fromScaled(o.amount),
    timestamp: Number(o.timestamp ?? 0),
  }
}

export function aggregateTradesToOHLC(trades: TradeRecord[], intervalSec: number): OHLCBar[] {
  if (trades.length === 0) return []
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp)
  const map = new Map<number, { open: number; high: number; low: number; close: number; volume: number }>()
  for (const t of sorted) {
    const ts = Number(t.timestamp)
    const price = Number(t.price)
    if (Number.isNaN(price) || price <= 0) continue
    const barStart = Math.floor(ts / intervalSec) * intervalSec
    const vol = Number.isFinite(t.amount) && t.amount > 0 ? t.amount : 0
    const existing = map.get(barStart)
    if (existing) {
      existing.high = Math.max(existing.high, price)
      existing.low = Math.min(existing.low, price)
      existing.close = price
      existing.volume += vol
    } else {
      map.set(barStart, { open: price, high: price, low: price, close: price, volume: vol })
    }
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([time, o]) => ({ time, ...o }))
}

export function useTradesOHLC(pair: string = DEFAULT_PAIR, intervalSec: number = BAR_INTERVAL_SEC) {
  const [bars, setBars] = useState<OHLCBar[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchTrades = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      const { data } = await nodeGet<unknown>('/api/trades', {
        pair,
        limit: String(TRADES_LIMIT),
      })
      const list = Array.isArray(data) ? data : []
      setBars(aggregateTradesToOHLC(list.map(normalizeTrade), intervalSec))
    } catch (e) {
      setBars([])
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [pair, intervalSec])

  useEffect(() => {
    fetchTrades()
  }, [fetchTrades])

  // 实时成交：追加或更新最后一根 K 线（WS 与 REST 同构，同为定点/wei，同样换算）
  useEffect(() => {
    const unsub = p2pWS.subscribe('trade', (msg) => {
      const data = msg.data as Record<string, unknown> | undefined
      if (!data || String(data.pair ?? '') !== pair) return
      const ts = Number(data.timestamp ?? 0)
      const price = fromScaled(data.price)
      if (Number.isNaN(price) || price <= 0) return
      const volRaw = fromScaled(data.amount)
      const vol = Number.isFinite(volRaw) && volRaw > 0 ? volRaw : 0
      const barStart = Math.floor(ts / intervalSec) * intervalSec
      setBars((prev) => {
        const copy = [...prev]
        const last = copy[copy.length - 1]
        if (last && last.time === barStart) {
          copy[copy.length - 1] = {
            ...last,
            high: Math.max(last.high, price),
            low: Math.min(last.low, price),
            close: price,
            volume: last.volume + vol,
          }
          return copy
        }
        const open = last?.close ?? price
        copy.push({
          time: barStart,
          open,
          high: Math.max(open, price),
          low: Math.min(open, price),
          close: price,
          volume: vol,
        })
        return copy
      })
    })
    return () => unsub()
  }, [pair, intervalSec])

  return { bars, loading, error, refetch: fetchTrades }
}
