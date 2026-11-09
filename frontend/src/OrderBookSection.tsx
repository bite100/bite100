/**
 * 完整订单簿：盘口展示、限价单下单、链上撤单、成交与结算状态。
 * 第 51 轮（无节点阶段 5 节点退役）：数据单源化——盘口与我的订单读
 * 订单中继簿、成交读链上索引、下单只走中继广播；原节点 API
 * （/api/orderbook、/api/trades、/api/orders、/api/node）与签名撤单
 * 一并退役。WebSocket/P2P 实时增量（浏览器 P2P 通道）保留。
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { ethers, Contract } from 'ethers'
import { VAULT_ABI, VAULT_ADDRESS, CHAIN_ID } from './config'
import { TRADE_PAIRS, getPairDecimals, getPairTokens } from './config/pairs'
import { useCurrentPair } from './hooks/useCurrentPair'
import { useListedPairs } from './hooks/useListedPairs'
import { useResolvedPair } from './hooks/useResolvedPair'
import { isListedPairKey } from './services/pairRegistry'
import { formatError, formatTokenAmount, getProvider, withTimeout, BALANCE_READ_TIMEOUT_MS } from './utils'
import { getCached, setCached, CACHE_KEYS_ORDERBOOK } from './dataCache'
import { usePairMarketPrice } from './hooks/useTokenPrice'
import { signOrder, generateOrderId, fetchOrderNonce } from './services/orderSigning'
import { sideToSignedValue } from './services/orderSigningTypes'
import { broadcastOrder, BROADCAST_UNKNOWN_MESSAGE } from './services/orderService'
import { RELAY_CONFIGURED } from './config/relay'
import { createRelayBookAdapter } from './services/dualread/adapters'
import type { RawOrder } from './services/dualread/types'
import { loadIndexerTrades } from './services/tradesDual'
import { verifyOrderSignatureSignedData } from './services/orderVerification'
import { LoadingSpinner } from './components/LoadingSpinner'
import { HardCancelAction } from './components/HardCancelAction'
import { ErrorDisplay } from './components/ErrorDisplay'
import { FeeDisplay } from './components/FeeDisplay'
import { VirtualList } from './components/VirtualList'
import { useOnlineStatus } from './hooks/useOnlineStatus'
import { p2pWS } from './services/wsClient'
import { p2pOrderBroadcast } from './p2p/orderBroadcast'
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

/** 订单状态的中文显示（与交易主屏页签区口径一致；未知状态原样显示） */
const STATUS_LABEL: Record<string, string> = {
  open: '挂单中',
  partial: '部分成交',
  filled: '已成交',
  cancelled: '已撤销',
  canceled: '已撤销',
  expired: '已过期',
  settled: '已结算',
}

const ORDERBOOK_DISPLAY_DEPTH = 100
const ORDERBOOK_ROW_HEIGHT = 28
const ORDERBOOK_PANEL_HEIGHT = 220
const TRADES_DISPLAY_LIMIT = 15
const hasRelayApi = () => RELAY_CONFIGURED

/** 中继簿行 → 本页 Order 视图（字段口径一致，逐字段搬运） */
function rawToOrder(r: RawOrder): Order {
  return {
    orderId: r.orderId,
    trader: r.trader,
    pair: r.pair,
    side: r.side,
    price: r.price,
    amount: r.amount,
    filled: r.filled,
    status: r.status,
    nonce: r.nonce,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    signature: r.signature,
  }
}

function normalizeOrder(o: Record<string, unknown>): Order {
  return {
    orderId: String(o.orderId ?? o.OrderID ?? ''),
    trader: String(o.trader ?? o.Trader ?? ''),
    pair: String(o.pair ?? ''),
    side: (o.side as 'buy' | 'sell') ?? 'buy',
    price: String(o.price ?? ''),
    amount: String(o.amount ?? ''),
    filled: String(o.filled ?? '0'),
    status: String(o.status ?? 'open'),
    nonce: Number(o.nonce ?? 0),
    createdAt: Number(o.createdAt ?? 0),
    expiresAt: Number(o.expiresAt ?? 0),
    signature: o.signature != null ? String(o.signature) : undefined,
  }
}

export interface OrderBookSectionProps {
  account: string | null
  getSigner: () => Promise<Signer | null>
  /** 从「完整订单簿」返回 Dashboard 简洁视图时调用 */
  onBackToDashboard?: () => void
}

export function OrderBookSection({ account, getSigner, onBackToDashboard }: OrderBookSectionProps) {
  // 第二十五轮：当前交易对与交易台共用 URL ?pair=（默认 BTC/USDT）
  const { pair, setPair } = useCurrentPair()
  const pairTokens = getPairTokens(CHAIN_ID, pair)
  // 第六十轮：自助上架对支持——符号/小数位走解析层，选对器合并注册表对，
  // 下单缩放按实际小数位（口径同下单表单，docs/round60 §2）；种子对 18/18 不变。
  const resolvedPair = useResolvedPair(CHAIN_ID, pair)
  const { pairs: listedPairs } = useListedPairs(CHAIN_ID)
  const pairDecimals = getPairDecimals(CHAIN_ID, pair)
  const baseDecimals = pairDecimals?.base ?? 18
  const quoteDecimals = pairDecimals?.quote ?? 18
  const priceDecimals = 18 + quoteDecimals - baseDecimals
  const baseSymbol = resolvedPair?.base.symbol ?? (isListedPairKey(pair) ? '基础币' : pair.split('/')[0])
  const quoteSymbol = resolvedPair?.quote.symbol ?? (isListedPairKey(pair) ? '计价币' : pair.split('/')[1])
  const displayPair = resolvedPair?.displayPair ?? (isListedPairKey(pair) ? '自助上架交易对' : pair)
  const listedPair = resolvedPair?.source === 'listed'
  const [orderbook, setOrderbook] = useState<OrderbookResponse | null>(null)
  // 第 54 轮：上一份簿改放 ref——此前它既是 state 又进了 fetchOrderbook 的
  // 依赖数组，每次拉到新簿就换 fetchOrderbook 身份、数据 effect 跟着重跑、
  // loading 被重新点亮，形成自触发无限循环（页面永远「加载中」）。
  // ref 不进依赖，动画比较照常读它。
  const prevOrderbookRef = useRef<OrderbookResponse | null>(null)
  // 已展示的簿（含缓存先行展示与 WS 增量）统一同步进 ref，供下次取簿时比较
  useEffect(() => {
    if (orderbook) prevOrderbookRef.current = orderbook
  }, [orderbook])
  // loading 只服务于「当前交易对的首次加载」：已加载过的 pair 在刷新
  // （P2P 事件 / 轮询）时静默更新，不再闪加载圈（第 54 轮）
  const loadedPairRef = useRef<string | null>(null)
  const [trades, setTrades] = useState<Trade[]>([])
  const [myOrders, setMyOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [price, setPrice] = useState('')
  const [amount, setAmount] = useState('')
  const [placeLoading, setPlaceLoading] = useState(false)
  const [refreshAt, setRefreshAt] = useState(0)
  const [fromCache, setFromCache] = useState<{ orderbook?: boolean; trades?: boolean; myOrders?: boolean }>({})
  const [tradesFilterMine, setTradesFilterMine] = useState(false) // 连接钱包后可过滤「我的交易」
  const [priceAnimations, setPriceAnimations] = useState<Map<string, 'up' | 'down'>>(new Map())
  const [balance, setBalance] = useState<string>('')
  const [balanceLoading, setBalanceLoading] = useState(false)
  const isOnline = useOnlineStatus()
  const { basePrice, quotePrice, loading: marketPriceLoading, error: marketPriceError } = usePairMarketPrice(pair)

  const fetchOrderbook = useCallback(async () => {
    if (!hasRelayApi()) return
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
      const book = await createRelayBookAdapter().fetchBook(CHAIN_ID, pair)
      const data: OrderbookResponse = {
        pair,
        bids: book.bids.map(rawToOrder),
        asks: book.asks.map(rawToOrder),
      }
      // 检测价格变化并设置动画（与上一份已展示的簿比较，读 ref 不读 state）
      const prev = prevOrderbookRef.current
      if (prev && prev.pair === pair) {
        const animMap = new Map<string, 'up' | 'down'>()
        // 检查买盘价格变化
        if (prev.bids.length > 0 && data.bids.length > 0) {
          const prevBestBid = parseFloat(prev.bids[0].price)
          const newBestBid = parseFloat(data.bids[0].price)
          if (newBestBid > prevBestBid) {
            animMap.set(data.bids[0].orderId, 'up')
          } else if (newBestBid < prevBestBid) {
            animMap.set(data.bids[0].orderId, 'down')
          }
        }
        // 检查卖盘价格变化
        if (prev.asks.length > 0 && data.asks.length > 0) {
          const prevBestAsk = parseFloat(prev.asks[0].price)
          const newBestAsk = parseFloat(data.asks[0].price)
          if (newBestAsk > prevBestAsk) {
            animMap.set(data.asks[0].orderId, 'up')
          } else if (newBestAsk < prevBestAsk) {
            animMap.set(data.asks[0].orderId, 'down')
          }
        }
        setPriceAnimations(animMap)
        // 动画结束后清除
        setTimeout(() => setPriceAnimations(new Map()), 600)
      }
      setOrderbook(data)
      setCached(cacheKey, data)
      setFromCache((f) => ({ ...f, orderbook: false }))
    } catch (e) {
      if (!cached) setOrderbook(null)
      setError((e as Error).message)
    }
  }, [pair, isOnline])

  const fetchTrades = useCallback(async () => {
    if (!hasRelayApi()) return
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
      // 成交单源 = 链上索引（展示值已是人类单位，字符串化进既有渲染）
      const outcome = await loadIndexerTrades(CHAIN_ID, pair, 30)
      if (outcome.failed) throw new Error('indexer unavailable')
      const list: Trade[] = outcome.trades.map((d) => ({
        tradeId: d.key,
        pair,
        maker: d.maker,
        taker: d.taker,
        price: String(d.price),
        amount: String(d.amount),
        timestamp: d.timestamp,
        txHash: d.txHash,
      }))
      setTrades(list)
      setCached(cacheKey, list)
      setFromCache((f) => ({ ...f, trades: false }))
    } catch {
      if (!cached) setTrades([])
    }
  }, [pair, isOnline])

  const fetchMyOrders = useCallback(async () => {
    if (!hasRelayApi() || !account) return
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
      const book = await createRelayBookAdapter().fetchBook(CHAIN_ID, pair)
      const list = [...book.bids, ...book.asks]
        .filter((r) => r.trader.toLowerCase() === account.toLowerCase())
        .map(rawToOrder)
      setMyOrders(list)
      setCached(cacheKey, list)
      setFromCache((f) => ({ ...f, myOrders: false }))
    } catch {
      if (!cached) setMyOrders([])
    }
  }, [account, pair, isOnline])

  useEffect(() => {
    if (!hasRelayApi()) return
    // 首次进入某交易对才点亮 loading；同 pair 的后续刷新（P2P 事件、
    // 15 秒轮询、撤单后刷新）只更新数据，不再让整页回到「加载中」
    const isFirstLoadForPair = loadedPairRef.current !== pair
    if (isFirstLoadForPair) setLoading(true)
    Promise.all([fetchOrderbook(), fetchTrades(), account ? fetchMyOrders() : Promise.resolve()]).finally(() => {
      loadedPairRef.current = pair
      setLoading(false)
    })
  }, [pair, account, refreshAt, fetchOrderbook, fetchTrades, fetchMyOrders])

  // 显式轮询保鲜（第 54 轮）：死循环修掉后，簿与成交改由 15 秒轮询 +
  // P2P/WS 事件保持新鲜；pair 变化不重置计时（取数回调自带当前 pair），
  // 卸载时清理
  useEffect(() => {
    if (!hasRelayApi()) return
    const t = setInterval(() => setRefreshAt((x) => x + 1), 15000)
    return () => clearInterval(t)
  }, [])

  // 获取余额
  const fetchBalance = useCallback(async () => {
    if (!account) {
      setBalance('')
      return
    }
    setBalanceLoading(true)
    try {
      const provider = getProvider()
      if (!provider) return
      if (!pairTokens) {
        setBalance('')
        return
      }
      const tokenAddress = side === 'sell' ? pairTokens.base : pairTokens.quote
      // 可用余额口径与交易面板一致：Vault 可用额（总额 − 挂单锁定）
      // 第 54 轮：套应用层超时——钱包 RPC 卡住时原调用永不落定，
      // balanceLoading 会永远 true；超时按读取失败走下方 catch 清空
      const vault = new Contract(VAULT_ADDRESS, VAULT_ABI, provider)
      const bal = await withTimeout(
        vault.availableBalance(account, tokenAddress) as Promise<bigint>,
        BALANCE_READ_TIMEOUT_MS,
        'vault availableBalance',
      )
      setBalance(formatTokenAmount(bal, side === 'sell' ? baseDecimals : quoteDecimals))
    } catch (e) {
      console.error('获取余额失败:', e)
      setBalance('')
    } finally {
      setBalanceLoading(false)
    }
  }, [account, side, pair, pairTokens])

  useEffect(() => {
    fetchBalance()
  }, [fetchBalance])

  // P2P 订单广播：启动 libp2p（Bootstrap + DHT），收到订单时刷新订单簿
  useEffect(() => {
    if (!hasRelayApi()) return
    let unsub: (() => void) | undefined
    p2pOrderBroadcast.start().then(() => {
      unsub = p2pOrderBroadcast.addOrderListener(() => {
        setRefreshAt((x) => x + 1)
      })
    })
    return () => { unsub?.() }
  }, [])

  // WebSocket 增量更新订单簿（pair 变化时订阅当前交易对）
  useEffect(() => {
    if (!hasRelayApi() || !p2pWS) return
    p2pWS.connect()
    const unsub = p2pWS.subscribe('orderbook_update', (msg) => {
      if (msg.pair !== pair || !msg.data) return
      const data = msg.data as { bids?: unknown[]; asks?: unknown[] }
      const bids = (data.bids ?? []).map((o) => normalizeOrder(o as Record<string, unknown>))
      const asks = (data.asks ?? []).map((o) => normalizeOrder(o as Record<string, unknown>))
      setOrderbook((prev) => {
        if (!prev || prev.pair !== pair) return { pair, bids, asks }
        // 检测价格变化
        const animMap = new Map<string, 'up' | 'down'>()
        if (prev.bids.length > 0 && bids.length > 0) {
          const prevBestBid = parseFloat(prev.bids[0].price)
          const newBestBid = parseFloat(bids[0].price)
          if (newBestBid > prevBestBid) animMap.set(bids[0].orderId, 'up')
          else if (newBestBid < prevBestBid) animMap.set(bids[0].orderId, 'down')
        }
        if (prev.asks.length > 0 && asks.length > 0) {
          const prevBestAsk = parseFloat(prev.asks[0].price)
          const newBestAsk = parseFloat(asks[0].price)
          if (newBestAsk > prevBestAsk) animMap.set(asks[0].orderId, 'up')
          else if (newBestAsk < prevBestAsk) animMap.set(asks[0].orderId, 'down')
        }
        setPriceAnimations(animMap)
        setTimeout(() => setPriceAnimations(new Map()), 600)
        return { ...prev, pair, bids, asks }
      })
    })
    return () => { unsub() }
  }, [pair])

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
    if (p > 1000000) {
      setError('价格过高，请检查输入')
      return
    }
    if (a > 1000000000) {
      setError('数量过大，请检查输入')
      return
    }
    // 余额检查
    if (balance) {
      const balanceNum = parseFloat(balance)
      if (!Number.isNaN(balanceNum) && !Number.isNaN(a) && a > balanceNum) {
        setError(`可用余额不足。当前可用：${balance}，需要：${amount}（挂单锁定的部分不计入可用）`)
        return
      }
    }
    setError(null)
    setPlaceLoading(true)
    try {
      const signer = await getSigner()
      if (!signer) throw new Error('请先连接钱包')
      if (!pairTokens) throw new Error(`交易对 ${displayPair} 未登记代币地址，无法下单`)
      const timestamp = Math.floor(Date.now() / 1000)
      const expiresAt = timestamp + 86400
      const amountInWei = ethers.parseUnits(amount, baseDecimals)
      const priceWei = ethers.parseUnits(price, priceDecimals)
      const amountOutWei = (BigInt(amountInWei.toString()) * BigInt(priceWei.toString())) / BigInt(1e18)
      const orderId = generateOrderId()
      // 统一规范：签名必须带链上结算 nonce（结算时被合约消耗）；广播/入库的 nonce 字段同此值，不再用时间戳冒充
      const nonce = await fetchOrderNonce(account, signer, CHAIN_ID)
      const orderData = {
        orderId,
        userAddress: account,
        tokenIn: pairTokens.base,
        tokenOut: pairTokens.quote,
        amountIn: amountInWei.toString(),
        amountOut: String(amountOutWei),
        price: priceWei.toString(),
        timestamp,
        expiresAt,
        nonce,
        side: sideToSignedValue(side),
      }
      const signature = await signOrder(orderData, signer, CHAIN_ID)
      const valid = await verifyOrderSignatureSignedData(orderData, signature, { chainId: CHAIN_ID })
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
        nonce,
        createdAt: timestamp,
        expiresAt,
        signature,
      }
      // 第 51 轮（阶段 5 节点退役）：下单只走中继单通道，中继接单即
      // 下单成功；明确拒单报错带原因，传输层失败（结果未定）按待
      // 确认呈现（第 46 轮 P2-3 口径沿用），提示勿重复下单。
      const broadcast = await broadcastOrder({ ...order }, CHAIN_ID)
      if (!broadcast.viaRelay) {
        if (broadcast.relayUnknown) throw new Error(BROADCAST_UNKNOWN_MESSAGE)
        throw broadcast.relayError instanceof Error
          ? broadcast.relayError
          : new Error('订单广播失败：中继未接单，请稍后重试')
      }
      await p2pOrderBroadcast.publishOrder({ ...order, signature: order.signature ?? '' })
      setPrice('')
      setAmount('')
      setRefreshAt((x) => x + 1)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setPlaceLoading(false)
    }
  }

  if (!hasRelayApi()) {
    return (
      <div className="card vault-section">
        <h2>完整订单簿</h2>
        <p className="hint">
          订单中继未配置，订单簿无法加载。订单簿、下单与撤单都经订单中继与链上完成（节点已退役）；你的链上资产与跨链桥不受影响。
        </p>
      </div>
    )
  }

  return (
    <div className="card vault-section orderbook-section">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>完整订单簿</h2>
        {onBackToDashboard && (
          <button type="button" className="btn secondary" onClick={onBackToDashboard} style={{ minHeight: 40 }}>
            返回交易台
          </button>
        )}
      </div>
      <p className="hint">
        完整的盘口深度、全部挂单与成交记录：盘口与挂单来自订单中继簿，成交来自链上索引。在此下单只需钱包签名、订单不上链；订单被中继接受时即锁定对应 Vault 余额（成交消耗、撤单或到期释放），可用余额不足的订单不会被接受。下单前请先在「资产」中存入足额余额；撤单在下方「我的订单」中用「链上撤单」——钱包直接上链释放这张单锁住的余额并在链上永久作废该单（自付少量 gas），中继簿里的记录会随订单到期自动清理。
        {(fromCache.orderbook || fromCache.trades || fromCache.myOrders) && (
          <span className="cache-hint"> · 部分数据来自本地缓存（5 分钟内）</span>
        )}
      </p>

      {!isOnline && (
        <p className="hint">
          当前处于离线状态，显示最近缓存的订单簿与成交记录；恢复网络后可下单与撤单。
        </p>
      )}

      <div className="row">
        <span className="label">交易对</span>
        <select className="input" value={pair} onChange={(e) => setPair(e.target.value)} style={{ width: 'auto' }}>
          {TRADE_PAIRS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
          {listedPairs.map((p) => (
            <option key={p.pairKey} value={p.pairKey}>
              {p.base.symbol}/{p.quote.symbol}（自助上架）
            </option>
          ))}
          {listedPair && resolvedPair && !listedPairs.some((p) => p.pairKey === pair) && (
            <option value={pair}>{resolvedPair.displayPair}（自助上架）</option>
          )}
        </select>
      </div>

      {listedPair && resolvedPair && (
        <p className="hint" style={{ border: '1px solid #ffa94d', background: '#fff4e6', borderRadius: 12, padding: '10px 12px' }}>
          ⚠ 自助上架交易对（未经审核）：这个交易对由用户自行上架，平台没有审核过这两个代币，
          冒牌币、诈骗币的风险真实存在。下单前请自己核对合约地址：{resolvedPair.base.symbol}{' '}
          {resolvedPair.base.address}；{resolvedPair.quote.symbol} {resolvedPair.quote.address}。
        </p>
      )}

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
          <span className="muted"> · 限价单按指定价格成交，无滑点</span>
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
          <h3>卖盘</h3>
          {loading ? (
            <LoadingSpinner size="small" text="加载中…" />
          ) : orderbook?.asks?.length ? (
            <>
              <div className="orderbook-table-header">
                <span>价格</span>
                <span>数量</span>
              </div>
              <VirtualList
                items={orderbook.asks.slice(0, ORDERBOOK_DISPLAY_DEPTH)}
                itemHeight={ORDERBOOK_ROW_HEIGHT}
                height={ORDERBOOK_PANEL_HEIGHT}
                getKey={(o) => o.orderId}
                className="orderbook-virtual"
              >
                {(o) => {
                  const anim = priceAnimations.get(o.orderId)
                  const animClass = anim === 'up' ? 'price-updated-up' : anim === 'down' ? 'price-updated-down' : ''
                  return (
                    <div className={`orderbook-row ask-row ${animClass}`}>
                      <span className="ask-price">{o.price}</span>
                      <span>{o.amount}</span>
                    </div>
                  )
                }}
              </VirtualList>
            </>
          ) : (
            <p className="hint">暂无卖单</p>
          )}
        </div>
        <div className="orderbook-panel">
          <h3>买盘</h3>
          {loading ? (
            <LoadingSpinner size="small" text="加载中…" />
          ) : orderbook?.bids?.length ? (
            <>
              <div className="orderbook-table-header">
                <span>价格</span>
                <span>数量</span>
              </div>
              <VirtualList
                items={orderbook.bids.slice(0, ORDERBOOK_DISPLAY_DEPTH)}
                itemHeight={ORDERBOOK_ROW_HEIGHT}
                height={ORDERBOOK_PANEL_HEIGHT}
                getKey={(o) => o.orderId}
                className="orderbook-virtual"
              >
                {(o) => {
                  const anim = priceAnimations.get(o.orderId)
                  const animClass = anim === 'up' ? 'price-updated-up' : anim === 'down' ? 'price-updated-down' : ''
                  return (
                    <div className={`orderbook-row bid-row ${animClass}`}>
                      <span className="bid-price">{o.price}</span>
                      <span>{o.amount}</span>
                    </div>
                  )
                }}
              </VirtualList>
            </>
          ) : (
            <p className="hint">暂无买单</p>
          )}
        </div>
      </div>

      {account && (
        <div className="place-order">
          <h3>限价下单</h3>
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
              onChange={(e) => {
                const val = e.target.value
                if (val === '' || /^\d*\.?\d*$/.test(val)) {
                  setPrice(val)
                  setError(null)
                }
              }}
              className="input"
            />
          </div>
          <div className="input-row">
            <input
              type="text"
              placeholder="数量"
              value={amount}
              onChange={(e) => {
                const val = e.target.value
                if (val === '' || /^\d*\.?\d*$/.test(val)) {
                  setAmount(val)
                  setError(null)
                }
              }}
              className="input"
            />
          </div>
          {account && (
            <div style={{ fontSize: '0.75rem', color: '#71717a', marginTop: '0.25rem' }}>
              {balanceLoading ? (
                <span>余额加载中…</span>
              ) : balance ? (
                <span>
                  可用余额：{balance} {side === 'sell' ? baseSymbol : quoteSymbol}
                </span>
              ) : null}
            </div>
          )}
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
              离线状态下仅可查看缓存数据，恢复网络后可下单。
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
                    <td>{STATUS_LABEL[o.status] ?? o.status}</td>
                    <td>
                      {(o.status === 'open' || o.status === 'partial') && (
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                          <HardCancelAction
                            order={o}
                            account={account}
                            getSigner={getSigner}
                            summary={`${o.side === 'buy' ? '买入' : '卖出'} ${o.amount} @ ${o.price}（${displayPair}）`}
                            onSettled={() => setRefreshAt((x) => x + 1)}
                          />
                        </div>
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
            showGasEstimate={true}
            tradeAmount={
              price && amount && !Number.isNaN(Number(price)) && !Number.isNaN(Number(amount))
                ? ethers.parseUnits(amount, baseDecimals)
                : undefined
            }
          />
        </div>
      )}
    </div>
  )
}
