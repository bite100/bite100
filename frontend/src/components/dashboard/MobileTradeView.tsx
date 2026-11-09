/**
 * 移动交易页（第 31 轮，<1024px）：交易对行 → 双列卡（左紧凑盘口 / 右下单票）→
 * 委托三页签卡 → 底部图表折叠条；图表展开态（K 线/深度图 + 盘口/最新成交）与
 * 选对页均为覆盖层。数据接线与桌面交易台完全同源（节点 API、签名、双路发送），
 * 桌面 ≥1024px 仍走第 28 轮 Dashboard 网格，互不影响。
 */
import { useMemo, useState } from 'react'
import type { Signer } from 'ethers'
import { CompactBook } from './CompactBook'
import { DepthChart } from './DepthChart'
import { KLineChart } from './KLineChart'
import { LimitOrderFormWidget } from './LimitOrderFormWidget'
import { OrderBookWidget } from './OrderBookWidget'
import { RecentTradesWidget } from './RecentTradesWidget'
import { TradeTabsPanel } from './TradeTabsPanel'
import { MarketsList } from '../markets/MarketsList'
import { useRelayOrderBook } from '../../hooks/useRelayOrderBook'
import { useReferencePrice } from '../../hooks/useReferencePrice'
import type { PairStats } from '../../hooks/usePairStats'
import { CHAIN_ID } from '../../config'
import { useResolvedPair } from '../../hooks/useResolvedPair'
import { isListedPairKey } from '../../services/pairRegistry'
import { fmtPrice } from './tradeFormat'
import './MobileTrade.css'

interface MobileTradeViewProps {
  /** 交易对：种子符号键或自助上架地址型键（第六十轮起为普通字符串） */
  pair: string
  setPair: (pair: string) => void
  stats: PairStats
  account: string | null
  getSigner: () => Promise<Signer | null>
  onShowFullOrderbook?: () => void
}

export function MobileTradeView({ pair, setPair, stats, account, getSigner, onShowFullOrderbook }: MobileTradeViewProps) {
  // 第六十轮：符号/展示名走解析层（自助对的 pair 是地址型键，不能拆键、不能直出）
  const resolvedPair = useResolvedPair(CHAIN_ID, pair)
  const [seedBase, seedQuote] = pair.split('/')
  const base = resolvedPair?.base.symbol ?? (isListedPairKey(pair) ? '基础币' : seedBase)
  const quote = resolvedPair?.quote.symbol ?? (isListedPairKey(pair) ? '计价币' : seedQuote)
  const displayPair = resolvedPair?.displayPair ?? (isListedPairKey(pair) ? '自助上架交易对' : pair)
  const [pricePick, setPricePick] = useState<{ price: string; seq: number }>({ price: '', seq: 0 })
  const [ordersRefresh, setOrdersRefresh] = useState(0)
  const [chartOpen, setChartOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [chartTab, setChartTab] = useState<'kline' | 'depth'>('kline')
  const [miniTab, setMiniTab] = useState<'book' | 'trades'>('book')

  const bookState = useRelayOrderBook(pair)
  const book = useMemo(
    () => ({ bids: bookState.bids, asks: bookState.asks }),
    [bookState.bids, bookState.asks],
  )
  const reference = useReferencePrice(pair, {
    lastTradePrice: stats.lastPrice,
    lastTradeAtSec: stats.lastTradeAt,
    book,
  })
  // 外部参考价（Chainlink 或 DexScreener 聚合报价）才作为参考锚展示；本所兜底价不冒充
  const refChainlink =
    reference.status === 'ok' &&
    (reference.ref.source === 'chainlink' || reference.ref.source === 'dexscreener')
      ? reference.ref.price
      : null

  const mid = useMemo(() => {
    const bb = book.bids.length ? Number(book.bids[0].price) : NaN
    const ba = book.asks.length ? Number(book.asks[0].price) : NaN
    return Number.isFinite(bb) && Number.isFinite(ba) && bb > 0 && ba > 0 ? String((bb + ba) / 2) : ''
  }, [book])

  const handlePriceClick = (price: string) => {
    setPricePick((prev) => ({ price, seq: prev.seq + 1 }))
  }

  const change = stats.change24hPct
  const changeCls = change == null ? '' : change >= 0 ? 'mtrade-up' : 'mtrade-down'

  return (
    <div className="mtrade">
      <div className="mtrade-pairrow">
        <button type="button" className="mtrade-pairbtn" onClick={() => setPickerOpen(true)}>
          <b>{displayPair}</b>
          <span className="mtrade-chev" aria-hidden="true">
            ▾
          </span>
        </button>
        <span className={`mtrade-change num ${changeCls}`}>
          {change == null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}
        </span>
        <span className="pill pill-spot">现货</span>
        <span className="mtrade-spacer" />
        <button type="button" className="mtrade-iconbtn" onClick={() => setChartOpen(true)} aria-label="展开图表">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M4 17V9M9.3 17V5M14.6 17v-6M20 17V7" />
            <path d="M3 20h18" />
          </svg>
        </button>
        <button type="button" className="mtrade-iconbtn" onClick={onShowFullOrderbook} aria-label="完整订单簿">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.7" />
            <circle cx="12" cy="12" r="1.7" />
            <circle cx="19" cy="12" r="1.7" />
          </svg>
        </button>
      </div>

      <section className="card mtrade-dual">
        <div className="mtrade-book">
          <CompactBook
            pair={pair}
            bids={bookState.bids}
            asks={bookState.asks}
            loading={bookState.loading}
            failed={bookState.failed}
            lastPrice={stats.lastPrice}
            changePct={stats.change24hPct}
            refPrice={refChainlink}
            onPriceClick={handlePriceClick}
          />
        </div>
        <div className="mtrade-ticket">
          <LimitOrderFormWidget
            layout="ticket"
            pair={pair}
            account={account}
            getSigner={getSigner}
            recommendedPrice={mid || undefined}
            externalPrice={pricePick}
            book={book}
            lastTradePrice={stats.lastPrice}
            lastTradeAtSec={stats.lastTradeAt}
            onSuccess={() => setOrdersRefresh((n) => n + 1)}
          />
        </div>
      </section>

      <section className="card mtrade-orders">
        <TradeTabsPanel
          variant="mobile"
          pair={pair}
          account={account}
          getSigner={getSigner}
          refreshSignal={ordersRefresh}
        />
        <button type="button" className="mtrade-booklink" onClick={onShowFullOrderbook}>
          查看完整订单簿 ›
        </button>
      </section>

      <button type="button" className="mtrade-chartbar" onClick={() => setChartOpen(true)}>
        <span>
          {displayPair} 图表
        </span>
        <span className="mtrade-chartbar-toggle">展开 ⌃</span>
      </button>

      {chartOpen && (
        <div className="mtrade-overlay" role="dialog" aria-label={`${displayPair} 图表`}>
          <section className="card mtrade-head-card">
            <div className="mtrade-head-top">
              <div>
                <div className="mtrade-head-pair">{displayPair}</div>
                <div className={`mtrade-head-last num ${changeCls}`}>
                  {stats.lastPrice != null ? fmtPrice(stats.lastPrice) : '暂无成交'}
                </div>
                {quote === 'USDT' && stats.lastPrice != null && (
                  <div className="mtrade-head-usd num">≈ ${fmtPrice(stats.lastPrice)}</div>
                )}
              </div>
              {change != null && (
                <span className={`markets-chg num ${change >= 0 ? 'up' : 'down'}`}>
                  {change >= 0 ? '+' : ''}
                  {change.toFixed(2)}%
                </span>
              )}
            </div>
            <div className="mtrade-head-grid num">
              <div>
                <span>参考价（Chainlink）</span>
                <b>{refChainlink != null ? fmtPrice(refChainlink) : '暂无'}</b>
              </div>
              <div>
                <span>24h 最高</span>
                <b>{stats.high24h != null ? fmtPrice(stats.high24h) : '—'}</b>
              </div>
              <div>
                <span>24h 最低</span>
                <b>{stats.low24h != null ? fmtPrice(stats.low24h) : '—'}</b>
              </div>
              <div>
                <span>24h 量（{quote}）</span>
                <b>{stats.volume24hQuote != null ? fmtPrice(stats.volume24hQuote) : '—'}</b>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="text-tabs">
              <button type="button" className={chartTab === 'kline' ? 'on' : undefined} onClick={() => setChartTab('kline')}>
                K 线
              </button>
              <button type="button" className={chartTab === 'depth' ? 'on' : undefined} onClick={() => setChartTab('depth')}>
                深度图
              </button>
            </div>
            <div className="mtrade-chart-body">
              {chartTab === 'kline' ? (
                <KLineChart pair={pair} />
              ) : (
                <DepthChart
                  bids={bookState.bids.map((r) => ({ price: Number(r.price), amount: Number(r.amount) }))}
                  asks={bookState.asks.map((r) => ({ price: Number(r.price), amount: Number(r.amount) }))}
                  lastPrice={stats.lastPrice}
                  base={base}
                />
              )}
            </div>
          </section>

          <section className="card">
            <div className="text-tabs">
              <button type="button" className={miniTab === 'book' ? 'on' : undefined} onClick={() => setMiniTab('book')}>
                盘口
              </button>
              <button type="button" className={miniTab === 'trades' ? 'on' : undefined} onClick={() => setMiniTab('trades')}>
                最新成交
              </button>
            </div>
            <div className="mtrade-chart-body">
              {miniTab === 'book' ? (
                <OrderBookWidget
                  pair={pair}
                  onPriceClick={(p) => {
                    handlePriceClick(p)
                    setChartOpen(false)
                  }}
                />
              ) : (
                <RecentTradesWidget pair={pair} />
              )}
            </div>
          </section>

          <button type="button" className="mtrade-chartbar" onClick={() => setChartOpen(false)}>
            <span>{displayPair} 图表</span>
            <span className="mtrade-chartbar-toggle">收起 ⌄</span>
          </button>
        </div>
      )}

      {pickerOpen && (
        <div className="mtrade-overlay" role="dialog" aria-label="选择交易对">
          <section className="card markets-card">
            <MarketsList
              chainId={CHAIN_ID}
              account={account}
              mode="picker"
              onBack={() => setPickerOpen(false)}
              onSelectPair={(p) => {
                setPair(p)
                setPickerOpen(false)
              }}
            />
          </section>
        </div>
      )}
    </div>
  )
}
