/**
 * 节点订单簿数据 hook（第 31 轮）：与 OrderBookWidget 完全相同的数据口径
 * （节点 /api/orderbook、定点→人类单位换算、5 秒轮询），供移动交易页的
 * 紧凑盘口与深度图共用同一份快照。桌面端仍由 OrderBookWidget 自带取数，行为不变。
 * （与既有 hooks/useOrderBook 的 P2P 事件版区分，故名 Node 版。）
 */
import { useEffect, useState } from 'react'
import { nodeGet } from '../nodeClient'
import { fromScaled, toPlain } from '../components/dashboard/tradeFormat'
import type { OrderBookRow } from '../components/dashboard/OrderBookWidget'

export interface NodeOrderBookState {
  bids: OrderBookRow[]
  asks: OrderBookRow[]
  loading: boolean
  failed: boolean
}

export function useNodeOrderBook(pair: string): NodeOrderBookState {
  const [state, setState] = useState<NodeOrderBookState>({ bids: [], asks: [], loading: true, failed: false })

  useEffect(() => {
    let cancelled = false
    setState((s) => ({ ...s, loading: true }))
    const fetchBook = async () => {
      try {
        const { data } = await nodeGet<{
          pair: string
          bids: Array<{ price: string; amount: string }>
          asks: Array<{ price: string; amount: string }>
        }>('/api/orderbook', { pair })
        if (cancelled) return
        const toRow = (o: { price: string; amount: string }, side: 'buy' | 'sell'): OrderBookRow => ({
          price: toPlain(fromScaled(o.price)),
          amount: toPlain(fromScaled(o.amount)),
          side,
        })
        setState({
          bids: (data.bids ?? []).slice(0, 15).map((o) => toRow(o, 'buy')),
          asks: (data.asks ?? []).slice(0, 15).map((o) => toRow(o, 'sell')),
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
