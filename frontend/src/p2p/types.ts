export interface Order {
  orderId: string
  trader: string
  pair: string
  side: 'buy' | 'sell'
  price: string
  amount: string
  timestamp: number
  signature: string
  /** 过期时间戳（毫秒），未设则永不过期；加载/恢复时过滤已过期订单 */
  expiresAt?: number
}

export interface CancelRequest {
  orderId: string
  signature: string
}

export interface Trade {
  tradeId: string
  makerOrderId: string
  takerOrderId: string
  maker: string
  taker: string
  pair: string
  price: string
  amount: string
  timestamp: number
  txHash?: string
  /** maker 方向（用于链上 settleTrade：tokenIn = maker 卖出） */
  makerSide?: 'buy' | 'sell'
}

export const TOPICS = {
  ORDER_NEW: '/p2p-exchange/order/new',
  ORDER_CANCEL: '/p2p-exchange/order/cancel',
  TRADE_EXECUTED: '/p2p-exchange/trade/executed',
  ORDERBOOK_SYNC: '/p2p-exchange/sync/orderbook',
}
