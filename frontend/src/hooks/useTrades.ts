import { useEffect, useState } from 'react'
import { Trade } from '../p2p/types'
import { TradeStorage, type OnChainTrade } from '../p2p/storage'

export function useTrades(pair?: string, userAddress?: string) {
  const [trades, setTrades] = useState<Trade[]>([])
  const [loading, setLoading] = useState(true)

  // 初始加载：从 IndexedDB 读取历史
  useEffect(() => {
    const loadHistoricalTrades = async () => {
      try {
        setLoading(true)
        
        let historicalTrades: OnChainTrade[]
        
        if (userAddress) {
          // 加载用户的成交历史
          historicalTrades = await TradeStorage.getUserTrades(userAddress, 50)
        } else if (pair) {
          // 加载交易对的成交历史
          historicalTrades = await TradeStorage.getTradesByPair(pair, 50)
        } else {
          // 加载所有成交（限制数量）
          historicalTrades = await TradeStorage.getTradesByPair('', 50)
        }
        
        setTrades(historicalTrades)
        console.log(`📦 从 IndexedDB 加载 ${historicalTrades.length} 条历史成交`)
      } catch (error) {
        console.error('❌ 加载历史成交失败:', error)
      } finally {
        setLoading(false)
      }
    }

    loadHistoricalTrades()
  }, [pair, userAddress])

  // 实时监听：P2P 网络广播的成交
  useEffect(() => {
    const handleTrade = (event: Event) => {
      const customEvent = event as CustomEvent
      const trade: Trade = customEvent.detail
      
      // 如果指定了交易对，只添加匹配的成交
      if (pair && trade.pair !== pair) return
      
      // 如果指定了用户地址，只添加相关的成交
      if (userAddress) {
        const addr = userAddress.toLowerCase()
        if (trade.maker.toLowerCase() !== addr && trade.taker.toLowerCase() !== addr) {
          return
        }
      }
      
      setTrades(prev => {
        // 去重（避免重复添加）
        if (prev.some(t => t.tradeId === trade.tradeId)) {
          return prev
        }
        return [trade, ...prev].slice(0, 50) // 保留最近 50 笔
      })
    }

    // 监听链上同步的成交
    const handleChainTrade = (event: Event) => {
      const customEvent = event as CustomEvent
      const trade: OnChainTrade = customEvent.detail
      
      if (pair && trade.pair !== pair) return
      
      if (userAddress) {
        const addr = userAddress.toLowerCase()
        if (trade.maker !== addr && trade.taker !== addr) {
          return
        }
      }
      
      setTrades(prev => {
        if (prev.some(t => t.tradeId === trade.tradeId)) {
          return prev
        }
        return [trade, ...prev].slice(0, 50)
      })
    }

    window.addEventListener('trade-executed', handleTrade)
    window.addEventListener('chain-trade-synced', handleChainTrade)

    return () => {
      window.removeEventListener('trade-executed', handleTrade)
      window.removeEventListener('chain-trade-synced', handleChainTrade)
    }
  }, [pair, userAddress])

  return { trades, loading }
}
