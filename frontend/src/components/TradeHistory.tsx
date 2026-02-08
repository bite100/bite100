import React from 'react'
import { useTrades } from '../hooks/useTrades'
import './TradeHistory.css'

interface TradeHistoryProps {
  pair?: string
}

export function TradeHistory({ pair }: TradeHistoryProps) {
  const trades = useTrades(pair)

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp)
    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }

  return (
    <div className="trade-history">
      <h3>最近成交{pair ? ` - ${pair}` : ''}</h3>
      
      <div className="trade-header">
        <span>时间</span>
        <span>价格</span>
        <span>数量</span>
      </div>
      
      <div className="trades-list">
        {trades.length === 0 && (
          <div className="empty-message">暂无成交记录</div>
        )}
        {trades.map(trade => (
          <div key={trade.tradeId} className="trade-item">
            <span className="time">{formatTime(trade.timestamp)}</span>
            <span className="price">{parseFloat(trade.price).toFixed(6)}</span>
            <span className="amount">{parseFloat(trade.amount).toFixed(4)}</span>
            {trade.txHash && (
              <a
                href={`https://sepolia.etherscan.io/tx/${trade.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="tx-link"
                title="查看链上交易"
              >
                ⛓️
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
