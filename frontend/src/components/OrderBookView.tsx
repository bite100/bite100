import React from 'react'
import { useOrderBook } from '../hooks/useOrderBook'
import './OrderBookView.css'

interface OrderBookViewProps {
  pair: string
}

export function OrderBookView({ pair }: OrderBookViewProps) {
  const { bids, asks } = useOrderBook(pair)

  const calculateSpread = () => {
    if (bids.length === 0 || asks.length === 0) return '-'
    const bestBid = parseFloat(bids[0].price)
    const bestAsk = parseFloat(asks[0].price)
    return (bestAsk - bestBid).toFixed(6)
  }

  return (
    <div className="orderbook-view">
      <h3>订单簿 - {pair}</h3>
      
      <div className="orderbook-header">
        <span>价格</span>
        <span>数量</span>
        <span>累计</span>
      </div>
      
      <div className="asks">
        {asks.length === 0 && (
          <div className="empty-message">暂无卖单</div>
        )}
        {asks.slice().reverse().map((ask, i) => {
          const cumulative = asks
            .slice(0, asks.length - i)
            .reduce((sum, o) => sum + parseFloat(o.amount), 0)
          
          return (
            <div key={ask.orderId} className="order-level ask">
              <span className="price">{parseFloat(ask.price).toFixed(6)}</span>
              <span className="amount">{parseFloat(ask.amount).toFixed(4)}</span>
              <span className="cumulative">{cumulative.toFixed(4)}</span>
            </div>
          )
        })}
      </div>
      
      <div className="spread">
        <span className="label">价差:</span>
        <span className="value">{calculateSpread()}</span>
      </div>
      
      <div className="bids">
        {bids.length === 0 && (
          <div className="empty-message">暂无买单</div>
        )}
        {bids.map((bid, i) => {
          const cumulative = bids
            .slice(0, i + 1)
            .reduce((sum, o) => sum + parseFloat(o.amount), 0)
          
          return (
            <div key={bid.orderId} className="order-level bid">
              <span className="price">{parseFloat(bid.price).toFixed(6)}</span>
              <span className="amount">{parseFloat(bid.amount).toFixed(4)}</span>
              <span className="cumulative">{cumulative.toFixed(4)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
