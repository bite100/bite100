/**
 * P2P DEX 交易机器人示例
 * 
 * 功能：
 * - 监控订单簿变化
 * - 自动下单（当价差满足条件时）
 * - 自动撤单（订单过期或条件不满足）
 * - 错误处理和重连
 */

const NODE_API_URL = 'http://localhost:8080'
const PAIR = 'TKA/TKB'
const CHECK_INTERVAL = 5000 // 5 秒检查一次

class TradingBot {
  constructor(config) {
    this.config = config
    this.orders = new Map() // orderId -> order
    this.running = false
  }

  async start() {
    console.log('交易机器人启动...')
    this.running = true
    await this.monitorOrderbook()
  }

  stop() {
    console.log('交易机器人停止')
    this.running = false
  }

  async monitorOrderbook() {
    while (this.running) {
      try {
        const orderbook = await this.fetchOrderbook()
        await this.processOrderbook(orderbook)
      } catch (error) {
        console.error('监控订单簿错误:', error)
        await this.sleep(1000) // 错误时等待 1 秒
        continue
      }

      await this.sleep(CHECK_INTERVAL)
    }
  }

  async fetchOrderbook() {
    const response = await fetch(`${NODE_API_URL}/api/orderbook?pair=${PAIR}`)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    return await response.json()
  }

  async processOrderbook(orderbook) {
    const { bids, asks } = orderbook

    if (bids.length === 0 || asks.length === 0) {
      console.log('订单簿为空，跳过处理')
      return
    }

    const bestBid = parseFloat(bids[0].price)
    const bestAsk = parseFloat(asks[0].price)
    const spread = bestAsk - bestBid
    const spreadPercent = (spread / bestBid) * 100

    console.log(`价差: ${spread.toFixed(6)} (${spreadPercent.toFixed(2)}%)`)

    // 示例策略：价差超过 1% 时下单
    if (spreadPercent > 1.0) {
      console.log('价差满足条件，准备下单...')
      // 这里可以添加下单逻辑
    }

    // 检查并清理过期订单
    await this.cleanupExpiredOrders()
  }

  async cleanupExpiredOrders() {
    const now = Math.floor(Date.now() / 1000)
    for (const [orderId, order] of this.orders.entries()) {
      if (order.expiresAt < now) {
        console.log(`订单 ${orderId} 已过期，准备撤单`)
        await this.cancelOrder(orderId)
        this.orders.delete(orderId)
      }
    }
  }

  async cancelOrder(orderId) {
    try {
      const response = await fetch(`${NODE_API_URL}/api/order/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId }),
      })

      if (!response.ok) {
        throw new Error(`取消订单失败: HTTP ${response.status}`)
      }

      console.log(`订单 ${orderId} 已取消`)
    } catch (error) {
      console.error(`取消订单错误:`, error)
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

// 使用示例
if (require.main === module) {
  const bot = new TradingBot({
    nodeUrl: NODE_API_URL,
    pair: PAIR,
  })

  bot.start().catch(console.error)

  // 优雅退出
  process.on('SIGINT', () => {
    bot.stop()
    process.exit(0)
  })
}

module.exports = TradingBot
