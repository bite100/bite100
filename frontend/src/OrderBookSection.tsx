/**
 * Phase 3.5：订单簿展示、限价单下单/撤单、成交与结算状态
 * 支持多节点 P2P（VITE_NODE_API_URL 逗号分隔多个 URL 时依次尝试）；手机端本地缓存订单簿/成交/我的订单
 */
import { useState, useEffect, useCallback } from 'react'
import { ethers } from 'ethers'
import { NODE_API_URL, NODE_API_URLS } from './config'
import { formatError } from './utils'
import { getCached, setCached, CACHE_KEYS_ORDERBOOK } from './dataCache'
import { nodeGet, nodePost } from './nodeClient'
import { usePairMarketPrice } from './hooks/useTokenPrice'
import { signOrder, signCancelOrder, generateOrderId } from './services/orderSigning'
import { verifyOrderSignatureSignedData } from './services/orderVerification'
import { TOKEN0_ADDRESS, TOKEN1_ADDRESS } from './config'
import { LoadingSpinner } from './components/LoadingSpinner'
import { ErrorDisplay } from './components/ErrorDisplay'
import { FeeDisplay } from './components/FeeDisplay'
import { useOnlineStatus } from './hooks/useOnlineStatus'
import type { Signer } from 'ethers'
import './App.css'

export interface Order {
  orderId: string
  trader: string
  pair: string
  side: 'buy' | 'sell'
  price: string
  amount: string
  filled: string
  status: string
  nonce: number
  createdAt: number
  expiresAt: number
  signature?: string
}

export interface Trade {
  tradeId: string
  pair: string
  makerOrderID?: string
  takerOrderID?: string
  maker?: string
  taker?: string
  tokenIn?: string
  tokenOut?: string
  amountIn?: string
  amountOut?: string
  price: string
  amount: string
  fee?: string
  timestamp: number
  txHash?: string
}

interface OrderbookResponse {
  pair: string
  bids: Order[]
  asks: Order[]
}

const DEFAULT_PAIR = 'TKA/TKB'
const ORDERBOOK_DISPLAY_DEPTH = 12
const TRADES_DISPLAY_LIMIT = 15
const hasNodeApi = () => !!(NODE_API_URL || NODE_API_URLS.length > 0)

export function OrderBookSection({ account, getSigner }: { account: string | null; getSigner: () => Promise<Signer | null> }) {
  const [pair, setPair] = useState(DEFAULT_PAIR)
  const [orderbook, setOrderbook] = useState<OrderbookResponse | null>(null)
  const [trades, setTrades] = useState<Trade[]>([])
  const [myOrders, setMyOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [price, setPrice] = useState('')
  const [amount, setAmount] = useState('')
  const [placeLoading, setPlaceLoading] = useState(false)
  const [cancelLoading, setCancelLoading] = useState<string | null>(null)
  const [refreshAt, setRefreshAt] = useState(0)
  const [nodeType, setNodeType] = useState<string | null>(null)
  const [connectedNode, setConnectedNode] = useState<string | null>(null)
  const [fromCache, setFromCache] = useState<{ orderbook?: boolean; trades?: boolean; myOrders?: boolean }>({})
  const [tradesFilterMine, setTradesFilterMine] = useState(false) // 连接钱包后可过滤「我的交易」
  const isOnline = useOnlineStatus()
  const { basePrice, quotePrice, loading: marketPriceLoading, error: marketPriceError } = usePairMarketPrice(pair)

  const fetchOrderbook = useCallback(async () => {
    if (!hasNodeApi()) return
    setError(null)
    const cacheKey = CACHE_KEYS_ORDERBOOK.orderbook(pair)
    const cached = getCached<OrderbookResponse>(cacheKey)
    if (cached) {
      setOrderbook(cached)
      setFromCache((f) => ({ ...f, orderbook: true }))
    }
    // 离线模式下仅使用缓存，不发起网络请求
    if (!isOnline) {
      return
    }
    try {
      const { data, baseUrl } = await nodeGet<OrderbookResponse>('/api/orderbook', { pair })
      setOrderbook(data)
      setCached(cacheKey, data)
      setConnectedNode(baseUrl)
      setFromCache((f) => ({ ...f, orderbook: false }))
    } catch (e) {
      if (!cached) setOrderbook(null)
      setError((e as Error).message)
    }
  }, [pair, isOnline])

  const fetchTrades = useCallback(async () => {
    if (!hasNodeApi()) return
    const cacheKey = CACHE_KEYS_ORDERBOOK.trades(pair)
    const cached = getCached<Trade[]>(cacheKey)
    if (cached) {
      setTrades(Array.isArray(cached) ? cached : [])
      setFromCache((f) => ({ ...f, trades: true }))
    }
    if (!isOnline) {
      return
    }
    try {
      const { data } = await nodeGet<Trade[]>('/api/trades', { pair, limit: '30' })
      const list = Array.isArray(data) ? data : []
      setTrades(list)
      setCached(cacheKey, list)
      setFromCache((f) => ({ ...f, trades: false }))
    } catch {
      if (!cached) setTrades([])
    }
  }, [pair, isOnline])

  const fetchMyOrders = useCallback(async () => {
    if (!hasNodeApi() || !account) return
    const cacheKey = CACHE_KEYS_ORDERBOOK.myOrders(account, pair)
    const cached = getCached<Order[]>(cacheKey)
    if (cached) {
      setMyOrders(Array.isArray(cached) ? cached : [])
      setFromCache((f) => ({ ...f, myOrders: true }))
    }
    if (!isOnline) {
      return
    }
    try {
      const { data } = await nodeGet<Order[]>('/api/orders', { trader: account, pair, limit: '50' })
      const list = Array.isArray(data) ? data : []
      setMyOrders(list)
      setCached(cacheKey, list)
      setFromCache((f) => ({ ...f, myOrders: false }))
    } catch {
      if (!cached) setMyOrders([])
    }
  }, [account, pair, isOnline])

  useEffect(() => {
    if (!hasNodeApi()) return
    nodeGet<{ nodeType: string }>('/api/node')
      .then(({ data, baseUrl }) => {
        setNodeType(data?.nodeType ?? null)
        setConnectedNode(baseUrl)
      })
      .catch(() => setNodeType(null))
  }, [])

  useEffect(() => {
    if (!hasNodeApi()) return
    setLoading(true)
    Promise.all([fetchOrderbook(), fetchTrades(), account ? fetchMyOrders() : Promise.resolve()]).finally(() =>
      setLoading(false)
    )
  }, [pair, account, refreshAt, fetchOrderbook, fetchTrades, fetchMyOrders])

  const handlePlaceOrder = async () => {
    if (!account || !price.trim() || !amount.trim()) {
      setError('请填写价格和数量')
      return
    }
    const p = parseFloat(price)
    const a = parseFloat(amount)
    if (Number.isNaN(p) || p <= 0 || Number.isNaN(a) || a <= 0) {
      setError('价格和数量须为正数')
      return
    }
    setError(null)
    setPlaceLoading(true)
    try {
      const signer = await getSigner()
      if (!signer) throw new Error('请先连接钱包')
      const timestamp = Math.floor(Date.now() / 1000)
      const expiresAt = timestamp + 86400
      const amountInWei = ethers.parseUnits(amount, 18)
      const priceWei = ethers.parseUnits(price, 18)
      const amountOutWei = (BigInt(amountInWei.toString()) * BigInt(priceWei.toString())) / BigInt(1e18)
      const orderId = generateOrderId()
      const orderData = {
        orderId,
        userAddress: account,
        tokenIn: TOKEN0_ADDRESS,
        tokenOut: TOKEN1_ADDRESS,
        amountIn: amountInWei.toString(),
        amountOut: String(amountOutWei),
        price: priceWei.toString(),
        timestamp,
        expiresAt,
      }
      const signature = await signOrder(orderData, signer)
      const valid = await verifyOrderSignatureSignedData(orderData, signature)
      if (!valid) {
        throw new Error('订单签名验证失败，请重试')
      }
      const order: Order = {
        orderId,
        trader: account,
        pair,
        side,
        price: orderData.price,
        amount: orderData.amountIn,
        filled: '0',
        status: 'open',
        nonce: timestamp,
        createdAt: timestamp,
        expiresAt,
        signature,
      }
      await nodePost('/api/order', order)
      setPrice('')
      setAmount('')
      setRefreshAt((x) => x + 1)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setPlaceLoading(false)
    }
  }

  const handleCancel = async (orderId: string) => {
    if (!account) return
    setCancelLoading(orderId)
    setError(null)
    try {
      const signer = await getSigner()
      if (!signer) throw new Error('请先连接钱包')
      const timestamp = Math.floor(Date.now() / 1000)
      const signature = await signCancelOrder(orderId, account, timestamp, signer)
      await nodePost('/api/order/cancel', { orderId, signature, timestamp })
      setRefreshAt((x) => x + 1)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setCancelLoading(null)
    }
  }

  if (!hasNodeApi()) {
    return (
      <div className="card vault-section">
        <h2>链下订单簿</h2>
        <p className="hint">
          请配置节点 API 地址（VITE_NODE_API_URL 或 .env 中 NODE_API_URL），并确保节点已开启 <code>api.listen</code>（如 :8080）。多节点可用逗号分隔，将按 P2P 方式依次尝试连接。
        </p>
      </div>
    )
  }

  return (
    <div className="card vault-section orderbook-section">
      <h2>链下订单簿</h2>
      <p className="hint">
        限价单下单/撤单、成交与结算状态（数据来自节点 API）
        {nodeType && (
          <span className="node-type"> · 节点类型：{nodeType === 'match' ? '撮合' : nodeType === 'storage' ? '存储' : '中继'}</span>
        )}
        {NODE_API_URLS.length > 1 && (
          <span className="node-type"> · P2P 多节点（{NODE_API_URLS.length} 个）</span>
        )}
        {connectedNode && (
          <span className="node-type"> · 当前节点：{connectedNode.replace(/^https?:\/\//, '').slice(0, 32)}{(connectedNode.length > 32 ? '…' : '')}</span>
        )}
        {(fromCache.orderbook || fromCache.trades || fromCache.myOrders) && (
          <span className="cache-hint"> · 部分为缓存数据（约 5 分钟内）</span>
        )}
      </p>

      {!isOnline && (
        <p className="hint">
          当前为离线模式，将显示最近缓存的订单簿和成交记录，暂无法下新单或撤单。
        </p>
      )}

      <div className="row">
        <span className="label">交易对</span>
        <select className="input" value={pair} onChange={(e) => setPair(e.target.value)} style={{ width: 'auto' }}>
          <option value="TKA/TKB">TKA/TKB</option>
        </select>
      </div>

      {marketPriceLoading && <p className="market-ref-hint">市场参考价加载中…</p>}
      {!marketPriceLoading && !marketPriceError && (basePrice || quotePrice) && (
        <p className="market-ref-hint">
          市场参考价：
          {basePrice && <strong>${basePrice.usd.toFixed(4)}</strong>}
          {basePrice && quotePrice && <span> / ${quotePrice.usd.toFixed(4)}</span>}
          {basePrice?.usd_24h_change != null && (
            <span className={basePrice.usd_24h_change >= 0 ? 'positive' : 'negative'}>
              {' '}({basePrice.usd_24h_change >= 0 ? '+' : ''}{basePrice.usd_24h_change.toFixed(2)}% 24h)
            </span>
          )}
          <span className="muted"> · P2P 零滑点限价 vs 主流 AMM 滑点 0.5%+</span>
        </p>
      )}
      {!marketPriceLoading && marketPriceError && (
        <p className="market-ref-hint muted">
          市场参考价服务暂时不可用，订单簿与下单功能仍可正常使用。
        </p>
      )}

      <ErrorDisplay error={error} onDismiss={() => setError(null)} />

      <div className="orderbook-grid">
        <div className="orderbook-panel">
          <h3>卖盘 Asks</h3>
          {loading ? (
            <LoadingSpinner size="small" text="加载中…" />
          ) : orderbook?.asks?.length ? (
            <table className="orderbook-table">
              <thead>
                <tr>
                  <th>价格</th>
                  <th>数量</th>
                </tr>
              </thead>
              <tbody>
                {orderbook.asks.slice(0, ORDERBOOK_DISPLAY_DEPTH).map((o) => (
                  <tr key={o.orderId}>
                    <td className="ask-price">{o.price}</td>
                    <td>{o.amount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="hint">暂无卖单</p>
          )}
        </div>
        <div className="orderbook-panel">
          <h3>买盘 Bids</h3>
          {loading ? (
            <LoadingSpinner size="small" text="加载中…" />
          ) : orderbook?.bids?.length ? (
            <table className="orderbook-table">
              <thead>
                <tr>
                  <th>价格</th>
                  <th>数量</th>
                </tr>
              </thead>
              <tbody>
                {orderbook.bids.slice(0, ORDERBOOK_DISPLAY_DEPTH).map((o) => (
                  <tr key={o.orderId}>
                    <td className="bid-price">{o.price}</td>
                    <td>{o.amount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="hint">暂无买单</p>
          )}
        </div>
      </div>

      {account && (
        <div className="place-order">
          <h3>下限价单</h3>
          <div className="row">
            <button
              type="button"
              className={side === 'buy' ? 'btn primary' : 'btn secondary'}
              onClick={() => setSide('buy')}
            >
              买入
            </button>
            <button
              type="button"
              className={side === 'sell' ? 'btn primary' : 'btn secondary'}
              onClick={() => setSide('sell')}
            >
              卖出
            </button>
          </div>
          <div className="input-row">
            <input
              type="text"
              placeholder="价格"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="input"
            />
          </div>
          <div className="input-row">
            <input
              type="text"
              placeholder="数量"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="input"
            />
          </div>
          <button
            type="button"
            className="btn primary"
            onClick={handlePlaceOrder}
            disabled={placeLoading || !price.trim() || !amount.trim() || !isOnline}
          >
            {placeLoading ? '提交中…' : side === 'buy' ? '买入' : '卖出'}
          </button>
          {!isOnline && (
            <p className="hint" style={{ marginTop: '0.5rem' }}>
              离线状态下仅可查看缓存订单簿，待恢复网络后再下新单。
            </p>
          )}
        </div>
      )}

      <div className="orderbook-bottom-grid">
        {account && myOrders.length > 0 && (
          <div className="my-orders">
            <h3>我的订单</h3>
            <table className="orderbook-table">
              <thead>
                <tr>
                  <th>方向</th>
                  <th>价格</th>
                  <th>数量</th>
                  <th>状态</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {myOrders.map((o) => (
                  <tr key={o.orderId}>
                    <td>{o.side === 'buy' ? '买' : '卖'}</td>
                    <td>{o.price}</td>
                    <td>{o.amount}</td>
                    <td>{o.status}</td>
                    <td>
                      {(o.status === 'open' || o.status === 'partial') && (
                        <button
                          type="button"
                          className="btn secondary"
                          onClick={() => handleCancel(o.orderId)}
                          disabled={cancelLoading === o.orderId}
                        >
                          {cancelLoading === o.orderId ? '…' : '撤单'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="trades-panel">
          <h3>
            最近成交
            {account && (
              <span className="trades-filter">
                <button
                  type="button"
                  className={!tradesFilterMine ? 'active' : ''}
                  onClick={() => setTradesFilterMine(false)}
                >
                  全部
                </button>
                <button
                  type="button"
                  className={tradesFilterMine ? 'active' : ''}
                  onClick={() => setTradesFilterMine(true)}
                >
                  我的
                </button>
              </span>
            )}
          </h3>
          {(() => {
            const displayed = tradesFilterMine && account
              ? trades.filter(
                  (t) =>
                    (t.maker?.toLowerCase() === account.toLowerCase()) ||
                    (t.taker?.toLowerCase() === account.toLowerCase())
                )
              : trades
            return displayed.length === 0 && !loading ? (
            <p className="hint">暂无成交</p>
          ) : (
            <table className="orderbook-table">
              <thead>
                <tr>
                  <th>价格</th>
                  <th>数量</th>
                  <th>时间</th>
                  <th>结算</th>
                </tr>
              </thead>
              <tbody>
                {displayed.slice(0, TRADES_DISPLAY_LIMIT).map((t) => (
                  <tr key={t.tradeId}>
                    <td>{t.price}</td>
                    <td>{t.amount}</td>
                    <td>{new Date(t.timestamp * 1000).toLocaleTimeString()}</td>
                    <td>{t.txHash ? <span className="settled">已上链</span> : <span className="hint">待结算</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
          })()}
        </div>
      </div>

      {account && (
        <div className="orderbook-fee-panel">
          <FeeDisplay
            platformFeePercent={0.01}
            feeDistribution={{ nodes: 20, developers: 30, liquidity: 50 }}
            showGasEstimate={true}
            tradeAmount={
              price && amount && !Number.isNaN(Number(price)) && !Number.isNaN(Number(amount))
                ? ethers.parseUnits(amount, 18)
                : undefined
            }
          />
        </div>
      )}
    </div>
  )
}
