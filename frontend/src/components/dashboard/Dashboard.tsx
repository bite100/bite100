import { useState, useEffect, useCallback } from 'react'
import { Paper } from '@mantine/core'
import { OrderBookWidget, type OrderBookRow } from './OrderBookWidget'
import { KLineChart } from './KLineChart'
import { LimitOrderFormWidget } from './LimitOrderFormWidget'
import { PairStatsBar } from './PairStatsBar'
import { RecentTradesWidget } from './RecentTradesWidget'
import { TradeTabsPanel } from './TradeTabsPanel'
import { usePairStats } from '../../hooks/usePairStats'
import { useCurrentPair } from '../../hooks/useCurrentPair'
import { p2pOrderBroadcast } from '../../p2p/orderBroadcast'
import type { Signer } from 'ethers'
import './TradeScreen.css'

export interface DashboardProps {
  account: string | null
  getSigner: () => Promise<Signer | null>
  /** 点击「完整订单簿」时切换为完整视图（我的订单、撤单等） */
  onShowFullOrderbook?: () => void
}

/** 从订单簿买卖盘计算中间价（用于推荐价与最新价兜底） */
function computeMidFromBook(
  bids: { price: string }[],
  asks: { price: string }[]
): string {
  const bestBid = bids.length ? Number(bids[0].price) : NaN
  const bestAsk = asks.length ? Number(asks[0].price) : NaN
  if (Number.isNaN(bestBid) || Number.isNaN(bestAsk) || bestBid <= 0 || bestAsk <= 0) return ''
  const mid = (bestBid + bestAsk) / 2
  return mid.toFixed(6)
}

/**
 * 交易主屏（第十二轮：布局对标 Hyperliquid，皮肤保留第十一轮浅色极简）。
 * 固定确定性网格：顶部信息条 / 左侧 K 线 + 页签表格 / 右栏盘口 + 最新成交 / 下单面板。
 * 此前可拖拽网格（react-grid-layout）按 Ren 指令让位于该固定布局；第十三轮已移除该依赖与旧网格样式。
 */
export function Dashboard({ account, getSigner, onShowFullOrderbook }: DashboardProps) {
  // 第二十五轮：当前交易对来自 URL ?pair=（默认 BTC/USDT），切换时统计/K 线/订单簿/
  // 下单/最新成交随同一 pair 值切换；旧对的价格带入不跨对沿用。
  const { pair, setPair } = useCurrentPair()
  const [recommendedPrice, setRecommendedPrice] = useState('')
  const [midPrice, setMidPrice] = useState('')
  const [pricePick, setPricePick] = useState<{ price: string; seq: number }>({ price: '', seq: 0 })
  const [ordersRefresh, setOrdersRefresh] = useState(0)
  const [book, setBook] = useState<{ bids: OrderBookRow[]; asks: OrderBookRow[] }>({ bids: [], asks: [] })
  const stats = usePairStats(pair)

  useEffect(() => {
    setRecommendedPrice('')
    setMidPrice('')
    setPricePick({ price: '', seq: 0 })
    setBook({ bids: [], asks: [] })
  }, [pair])

  // 进入 Dashboard 时启动 P2P（Bootstrap + DHT），便于挂单时广播
  useEffect(() => {
    p2pOrderBroadcast.start().catch(() => {})
  }, [])

  const handleBookUpdate = useCallback((bids: OrderBookRow[], asks: OrderBookRow[]) => {
    const mid = computeMidFromBook(bids, asks)
    setRecommendedPrice(mid)
    setMidPrice(mid)
    setBook({ bids, asks })
  }, [])

  const handlePriceClick = useCallback((price: string) => {
    setPricePick((prev) => ({ price, seq: prev.seq + 1 }))
  }, [])

  return (
    <div className="trade-screen">
      <PairStatsBar
        pair={pair}
        stats={stats}
        midPrice={midPrice || undefined}
        onPairChange={setPair}
        onShowFullOrderbook={onShowFullOrderbook}
      />
      <div className="trade-main">
        <Paper className="trade-card trade-area-chart" p="md" shadow="xs" withBorder>
          <KLineChart pair={pair} />
        </Paper>

        <Paper className="trade-card trade-area-tabs" p="md" shadow="xs" withBorder>
          <TradeTabsPanel pair={pair} account={account} getSigner={getSigner} refreshSignal={ordersRefresh} />
        </Paper>

        <div className="trade-area-rail">
          <Paper className="trade-card" p="sm" shadow="xs" withBorder>
            <OrderBookWidget pair={pair} onBookUpdate={handleBookUpdate} onPriceClick={handlePriceClick} />
          </Paper>
          <Paper className="trade-card" p="sm" shadow="xs" withBorder>
            <RecentTradesWidget pair={pair} />
          </Paper>
        </div>

        <Paper
          className="trade-card trade-area-side dashboard-orderform"
          p="md"
          shadow="xs"
          withBorder
        >
          <LimitOrderFormWidget
            pair={pair}
            account={account}
            getSigner={getSigner}
            recommendedPrice={recommendedPrice || undefined}
            externalPrice={pricePick}
            book={book}
            lastTradePrice={stats.lastPrice}
            lastTradeAtSec={stats.lastTradeAt}
            onSuccess={() => setOrdersRefresh((n) => n + 1)}
          />
        </Paper>
      </div>
    </div>
  )
}
