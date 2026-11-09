/**
 * 拉取成交并聚合成 OHLC K 线（供 KLineChart 使用）。数据源第 51 轮
 * （阶段 5 节点退役）由节点 /api/trades 改为链上索引（loadIndexerTrades，
 * Envio Trade 事件）——聚合逻辑保留，只换数据入口（无节点设计 §5）；
 * 索引是轮询源，故补 30 秒轮询刷新。可选：通过 p2pWS 订阅 trade 实时
 * 追加/更新最后一根 K 线（浏览器 P2P 通道，非节点 API，保留）。
 *
 * 单位：索引展示行 price/amount 已是人类单位，直接聚合（第 28 轮起的
 * 定点换算在 tradesDual 的展示换算里完成）。
 */
import { useState, useEffect, useCallback } from 'react'
import { CHAIN_ID } from '../config'
import { loadIndexerTrades } from '../services/tradesDual'
import { p2pWS } from '../services/wsClient'
import { fromScaled } from '../components/dashboard/tradeFormat'

const DEFAULT_PAIR = 'TKA/TKB'
const BAR_INTERVAL_SEC = 3600 // 1 小时一根 K 线
const TRADES_LIMIT = 500
const POLL_MS = 30000

export interface TradeRecord {
  tradeId?: string
  pair?: string
  /** 人类单位价格 */
  price: number
  /** 人类单位数量 */
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

/** 把原始成交行（定点/wei 字符串）归一化为人类单位记录（供 p2pWS 实时行与单测使用）；不可解析的价格记为 NaN 由聚合层过滤 */
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
      const outcome = await loadIndexerTrades(CHAIN_ID, pair, TRADES_LIMIT)
      if (outcome.failed) throw new Error('链上索引暂不可达，成交数据暂不可用')
      setBars(
        aggregateTradesToOHLC(
          outcome.trades.map((t) => ({
            tradeId: t.key,
            price: t.price,
            amount: t.amount,
            timestamp: t.timestamp,
          })),
          intervalSec,
        ),
      )
    } catch (e) {
      setBars([])
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [pair, intervalSec])

  useEffect(() => {
    fetchTrades()
    // 索引为轮询源：30 秒刷新一次（原节点路径靠单次拉取 + WS 追加）
    const t = setInterval(fetchTrades, POLL_MS)
    return () => clearInterval(t)
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
