/**
 * 从节点 /api/trades 拉取成交并聚合成 OHLC K 线（供 KLineChart 使用）
 * 可选：通过 p2pWS 订阅 trade 实时追加/更新最后一根 K 线
 */
import { useState, useEffect, useCallback } from 'react'
import { nodeGet } from '../nodeClient'
import { p2pWS } from '../services/wsClient'

const DEFAULT_PAIR = 'TKA/TKB'
const BAR_INTERVAL_SEC = 3600 // 1 小时一根 K 线
const TRADES_LIMIT = 500

export interface TradeRecord {
  tradeId?: string
  pair?: string
  price: string
  amount: string
  timestamp: number
}

export interface OHLCBar {
  time: number
  open: number
  high: number
  low: number
  close: number
}

function aggregateTradesToOHLC(trades: TradeRecord[], intervalSec: number): OHLCBar[] {
  if (trades.length === 0) return []
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp)
  const map = new Map<number, { open: number; high: number; low: number; close: number; count: number }>()
  for (const t of sorted) {
    const ts = Number(t.timestamp)
    const price = Number(t.price)
    if (Number.isNaN(price) || price <= 0) continue
    const barStart = Math.floor(ts / intervalSec) * intervalSec
    const existing = map.get(barStart)
    if (existing) {
      existing.high = Math.max(existing.high, price)
      existing.low = Math.min(existing.low, price)
      existing.close = price
      existing.count += 1
    } else {
      map.set(barStart, { open: price, high: price, low: price, close: price, count: 1 })
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
      const normalized: TradeRecord[] = list.map((t: unknown) => {
        const o: Record<string, unknown> = (t && typeof t === 'object' && t) ? (t as Record<string, unknown>) : {}
        return {
          tradeId: String(o.tradeId ?? o.TradeID ?? ''),
          pair: String(o.pair ?? ''),
          price: String(o.price ?? ''),
          amount: String(o.amount ?? ''),
          timestamp: Number(o.timestamp ?? 0),
        }
      })
      setBars(aggregateTradesToOHLC(normalized, intervalSec))
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

  // 实时成交：追加或更新最后一根 K 线
  useEffect(() => {
    const unsub = p2pWS.subscribe('trade', (msg) => {
      const data = msg.data as Record<string, unknown> | undefined
      if (!data || String(data.pair ?? '') !== pair) return
      const ts = Number(data.timestamp ?? 0)
      const price = Number(data.price ?? 0)
      if (Number.isNaN(price) || price <= 0) return
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
        })
        return copy
      })
    })
    return () => unsub()
  }, [pair, intervalSec])

  return { bars, loading, error, refetch: fetchTrades }
}
