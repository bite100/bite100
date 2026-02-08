export interface Order {
  orderId: string
  trader: string
  pair: string
  side: 'buy' | 'sell'
  price: string
  amount: string
  timestamp: number
  signature: string
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
}

export const TOPICS = {
  ORDER_NEW: '/p2p-exchange/order/new',
  ORDER_CANCEL: '/p2p-exchange/order/cancel',
  TRADE_EXECUTED: '/p2p-exchange/trade/executed',
  ORDERBOOK_SYNC: '/p2p-exchange/sync/orderbook',
}
