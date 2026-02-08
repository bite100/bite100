import { Order, Trade } from './types'

/**
 * 简化的撮合引擎
 * 使用内存 Map 存储订单簿（高性能）
 * 扩展时可使用 IndexedDB 持久化
 */

interface OrderBook {
  bids: Order[] // 买盘（价格降序）
  asks: Order[] // 卖盘（价格升序）
}

export class MatchEngine {
  // 内存 Map 存储订单簿（快速访问）
  private orderbooks = new Map<string, OrderBook>()
  // 订单 ID 到交易对的映射（快速查找）
  private orderIdMap = new Map<string, string>()

  /**
   * 添加订单到订单簿
   * 时间复杂度：O(n log n) 排序
   */
  addOrder(order: Order): void {
    const book = this.getOrCreateOrderBook(order.pair)
    
    // 移除同 ID 订单（避免重复）
    this.removeOrder(order.orderId)
    
    // 添加到对应盘口
    if (order.side === 'buy') {
      book.bids.push(order)
      // 买盘：价格降序，时间升序
      book.bids.sort((a, b) => {
        const priceDiff = parseFloat(b.price) - parseFloat(a.price)
        return priceDiff !== 0 ? priceDiff : a.timestamp - b.timestamp
      })
    } else {
      book.asks.push(order)
      // 卖盘：价格升序，时间升序
      book.asks.sort((a, b) => {
        const priceDiff = parseFloat(a.price) - parseFloat(b.price)
        return priceDiff !== 0 ? priceDiff : a.timestamp - b.timestamp
      })
    }
    
    this.orderIdMap.set(order.orderId, order.pair)
    
    // 触发订单簿更新事件
    this.emitOrderBookUpdate(order.pair)
  }

  /**
   * 移除订单
   * 时间复杂度：O(n)
   */
  removeOrder(orderId: string): void {
    const pair = this.orderIdMap.get(orderId)
    if (!pair) return
    
    const book = this.orderbooks.get(pair)
    if (!book) return
    
    // 使用 filter 移除（简单高效）
    book.bids = book.bids.filter(o => o.orderId !== orderId)
    book.asks = book.asks.filter(o => o.orderId !== orderId)
    
    this.orderIdMap.delete(orderId)
    this.emitOrderBookUpdate(pair)
  }

  /**
   * 撮合订单
   * Price-Time 优先算法
   * 时间复杂度：O(n) n 为匹配的订单数
   */
  match(takerOrder: Order): Trade[] {
    const book = this.getOrCreateOrderBook(takerOrder.pair)
    const trades: Trade[] = []
    
    let remainingAmount = parseFloat(takerOrder.amount)
    
    if (takerOrder.side === 'buy') {
      // 买单吃卖盘
      while (book.asks.length > 0 && remainingAmount > 0) {
        const makerOrder = book.asks[0]
        const makerPrice = parseFloat(makerOrder.price)
        const takerPrice = parseFloat(takerOrder.price)
        
        // 价格不匹配，停止撮合
        if (takerPrice < makerPrice) break
        
        // 计算成交量
        const makerAmount = parseFloat(makerOrder.amount)
        const matchAmount = Math.min(remainingAmount, makerAmount)
        
        // 创建成交记录
        trades.push({
          tradeId: `${takerOrder.orderId}-${Date.now()}-${trades.length}`,
          makerOrderId: makerOrder.orderId,
          takerOrderId: takerOrder.orderId,
          maker: makerOrder.trader,
          taker: takerOrder.trader,
          pair: takerOrder.pair,
          price: makerOrder.price,
          amount: matchAmount.toString(),
          timestamp: Date.now(),
        })
        
        // 更新剩余量
        remainingAmount -= matchAmount
        makerOrder.amount = (makerAmount - matchAmount).toString()
        
        // 如果 maker 订单完全成交，移除
        if (parseFloat(makerOrder.amount) <= 0) {
          book.asks.shift()
          this.orderIdMap.delete(makerOrder.orderId)
        }
      }
    } else {
      // 卖单吃买盘（逻辑类似）
      while (book.bids.length > 0 && remainingAmount > 0) {
        const makerOrder = book.bids[0]
        const makerPrice = parseFloat(makerOrder.price)
        const takerPrice = parseFloat(takerOrder.price)
        
        if (takerPrice > makerPrice) break
        
        const makerAmount = parseFloat(makerOrder.amount)
        const matchAmount = Math.min(remainingAmount, makerAmount)
        
        trades.push({
          tradeId: `${takerOrder.orderId}-${Date.now()}-${trades.length}`,
          makerOrderId: makerOrder.orderId,
          takerOrderId: takerOrder.orderId,
          maker: makerOrder.trader,
          taker: takerOrder.trader,
          pair: takerOrder.pair,
          price: makerOrder.price,
          amount: matchAmount.toString(),
          timestamp: Date.now(),
        })
        
        remainingAmount -= matchAmount
        makerOrder.amount = (makerAmount - matchAmount).toString()
        
        if (parseFloat(makerOrder.amount) <= 0) {
          book.bids.shift()
          this.orderIdMap.delete(makerOrder.orderId)
        }
      }
    }
    
    if (trades.length > 0) {
      console.log(`✅ 撮合成功: ${trades.length} 笔成交`)
      this.emitOrderBookUpdate(takerOrder.pair)
    }
    
    return trades
  }

  /**
   * 获取订单簿
   */
  getOrderBook(pair: string): OrderBook {
    return this.getOrCreateOrderBook(pair)
  }

  /**
   * 获取或创建订单簿
   */
  private getOrCreateOrderBook(pair: string): OrderBook {
    if (!this.orderbooks.has(pair)) {
      this.orderbooks.set(pair, { bids: [], asks: [] })
    }
    return this.orderbooks.get(pair)!
  }

  /**
   * 触发订单簿更新事件
   */
  private emitOrderBookUpdate(pair: string): void {
    const book = this.orderbooks.get(pair)
    if (!book) return
    
    window.dispatchEvent(new CustomEvent('orderbook-update', {
      detail: {
        pair,
        bids: book.bids.slice(0, 20), // 只发送前 20 档
        asks: book.asks.slice(0, 20),
      }
    }))
  }

  /**
   * 获取统计信息
   */
  getStats(): { pairs: number; orders: number } {
    let totalOrders = 0
    for (const book of this.orderbooks.values()) {
      totalOrders += book.bids.length + book.asks.length
    }
    return {
      pairs: this.orderbooks.size,
      orders: totalOrders,
    }
  }

  /**
   * 清空所有订单簿
   */
  clear(): void {
    this.orderbooks.clear()
    this.orderIdMap.clear()
    console.log('🧹 订单簿已清空')
  }
}
