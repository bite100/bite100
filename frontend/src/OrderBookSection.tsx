/**
 * Phase 3.5：订单簿展示、限价单下单/撤单、成交与结算状态
 * 需配置 NODE_API_URL（节点 api.listen 开启后）
 */
import { useState, useEffect, useCallback } from 'react'
import { ethers } from 'ethers'
import { NODE_API_URL } from './config'
import { formatError } from './utils'
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

function apiGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(path, NODE_API_URL)
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  return fetch(url.toString()).then((r) => {
    if (!r.ok) throw new Error(r.statusText || String(r.status))
    return r.json()
  })
}

function apiPost(path: string, body: unknown): Promise<{ ok: boolean }> {
  return fetch(`${NODE_API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => {
    if (!r.ok) throw new Error(r.statusText || String(r.status))
    return r.json()
  })
}

/** 生成 orderId：keccak256(abi.encodePacked(trader, nonce, pair, side, price, amount)) */
function buildOrderId(trader: string, nonce: number, pair: string, side: string, price: string, amount: string): string {
  const addr = trader.length === 42 && trader.startsWith('0x') ? trader : ethers.getAddress(trader)
  return ethers.solidityPackedKeccak256(
    ['address', 'uint64', 'string', 'string', 'string', 'string'],
    [addr, BigInt(nonce), pair, side, price, amount]
  )
}

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

  const fetchOrderbook = useCallback(async () => {
    if (!NODE_API_URL) return
    setError(null)
    try {
      const data = await apiGet<OrderbookResponse>('/api/orderbook', { pair })
      setOrderbook(data)
    } catch (e) {
      setOrderbook(null)
      setError((e as Error).message)
    }
  }, [pair])

  const fetchTrades = useCallback(async () => {
    if (!NODE_API_URL) return
    try {
      const data = await apiGet<Trade[]>('/api/trades', { pair, limit: '30' })
      setTrades(Array.isArray(data) ? data : [])
    } catch {
      setTrades([])
    }
  }, [pair])

  const fetchMyOrders = useCallback(async () => {
    if (!NODE_API_URL || !account) return
    try {
      const data = await apiGet<Order[]>('/api/orders', { trader: account, pair, limit: '50' })
      setMyOrders(Array.isArray(data) ? data : [])
    } catch {
      setMyOrders([])
    }
  }, [account, pair])

  useEffect(() => {
    if (!NODE_API_URL) return
    apiGet<{ nodeType: string }>('/api/node')
      .then((d) => setNodeType(d?.nodeType ?? null))
      .catch(() => setNodeType(null))
  }, [])

  useEffect(() => {
    if (!NODE_API_URL) return
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
      const nonce = Math.floor(Date.now() / 1000)
      const priceStr = p.toFixed(18)
      const amountStr = a.toFixed(18)
      const orderId = buildOrderId(account, nonce, pair, side, priceStr, amountStr)
      const sig = await signer.signMessage(ethers.getBytes(orderId))
      const sigHex = ethers.hexlify(ethers.getBytes(sig))
      const order: Order = {
        orderId,
        trader: account,
        pair,
        side,
        price: priceStr,
        amount: amountStr,
        filled: '0',
        status: 'open',
        nonce,
        createdAt: nonce,
        expiresAt: 0,
        signature: sigHex,
      }
      await apiPost('/api/order', order)
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
      const sig = await signer.signMessage(ethers.getBytes(orderId))
      await apiPost('/api/order/cancel', { orderId, signature: ethers.hexlify(ethers.getBytes(sig)) })
      setRefreshAt((x) => x + 1)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setCancelLoading(null)
    }
  }

  if (!NODE_API_URL) {
    return (
      <div className="card vault-section">
        <h2>链下订单簿</h2>
        <p className="hint">
          请配置节点 API 地址（VITE_NODE_API_URL 或 .env 中 NODE_API_URL），并确保节点已开启 <code>api.listen</code>（如 :8080）。
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
      </p>

      <div className="row">
        <span className="label">交易对</span>
        <select className="input" value={pair} onChange={(e) => setPair(e.target.value)} style={{ width: 'auto' }}>
          <option value="TKA/TKB">TKA/TKB</option>
        </select>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="orderbook-grid">
        <div className="orderbook-panel">
          <h3>卖盘 Asks</h3>
          {loading ? (
            <p className="hint">加载中…</p>
          ) : orderbook?.asks?.length ? (
            <table className="orderbook-table">
              <thead>
                <tr>
                  <th>价格</th>
                  <th>数量</th>
                </tr>
              </thead>
              <tbody>
                {orderbook.asks.slice(0, 12).map((o) => (
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
            <p className="hint">加载中…</p>
          ) : orderbook?.bids?.length ? (
            <table className="orderbook-table">
              <thead>
                <tr>
                  <th>价格</th>
                  <th>数量</th>
                </tr>
              </thead>
              <tbody>
                {orderbook.bids.slice(0, 12).map((o) => (
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
            disabled={placeLoading || !price.trim() || !amount.trim()}
          >
            {placeLoading ? '提交中…' : side === 'buy' ? '买入' : '卖出'}
          </button>
        </div>
      )}

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
        <h3>最近成交</h3>
        {trades.length === 0 && !loading ? (
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
              {trades.slice(0, 15).map((t) => (
                <tr key={t.tradeId}>
                  <td>{t.price}</td>
                  <td>{t.amount}</td>
                  <td>{new Date(t.timestamp * 1000).toLocaleTimeString()}</td>
                  <td>{t.txHash ? <span className="settled">已上链</span> : <span className="hint">待结算</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
