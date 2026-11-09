/**
 * 中继订单簿数据 hook：第 31 轮建立时读节点 /api/orderbook，第 51 轮
 * （阶段 5 节点退役）改读订单中继簿（createRelayBookAdapter，自带
 * 10 秒超时），供移动交易页的紧凑盘口与深度图共用同一份快照。桌面端
 * 由 OrderBookWidget 走同一适配器取数，口径一致（定点→人类单位换算、
 * 5 秒轮询）。原名 useNodeOrderBook 随节点退役更名。
 */
import { useEffect, useState } from 'react'
import { CHAIN_ID } from '../config'
import { createRelayBookAdapter } from '../services/dualread/adapters'
import { getPairDecimals } from '../config/pairs'
import { fromScaledDecimals, toPlain } from '../components/dashboard/tradeFormat'
import type { OrderBookRow } from '../components/dashboard/OrderBookWidget'

export interface RelayOrderBookState {
  bids: OrderBookRow[]
  asks: OrderBookRow[]
  loading: boolean
  failed: boolean
}

export function useRelayOrderBook(pair: string): RelayOrderBookState {
  const [state, setState] = useState<RelayOrderBookState>({ bids: [], asks: [], loading: true, failed: false })

  useEffect(() => {
    let cancelled = false
    setState((s) => ({ ...s, loading: true }))
    const adapter = createRelayBookAdapter()
    const fetchBook = async () => {
      try {
        const book = await adapter.fetchBook(CHAIN_ID, pair)
        if (cancelled) return
        // 第六十轮：按交易对实际小数位换算（价格缩放 18+quote−base、数量缩放
        // base）；种子对 18/18 与旧口径一致。每次轮询现读，注册表缓存变热后自动跟上。
        const dec = getPairDecimals(CHAIN_ID, pair)
        const priceDec = dec ? 18 + dec.quote - dec.base : 18
        const amountDec = dec?.base ?? 18
        const toRow = (o: { price: string; amount: string }, side: 'buy' | 'sell'): OrderBookRow => ({
          price: toPlain(fromScaledDecimals(o.price, priceDec)),
          amount: toPlain(fromScaledDecimals(o.amount, amountDec)),
          side,
        })
        setState({
          bids: book.bids.slice(0, 15).map((o) => toRow(o, 'buy')),
          asks: book.asks.slice(0, 15).map((o) => toRow(o, 'sell')),
          loading: false,
          failed: false,
        })
      } catch {
        if (!cancelled) setState({ bids: [], asks: [], loading: false, failed: true })
      }
    }
    fetchBook()
    const t = setInterval(fetchBook, 5000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [pair])

  return state
}
