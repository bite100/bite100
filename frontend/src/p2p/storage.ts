import Dexie, { type Table } from 'dexie'
import { Order, Trade } from './types'

/**
 * 分层数据存储方案
 * 
 * 层级 1: localStorage - 用户配置、最近访问
 * 层级 2: IndexedDB (Dexie) - 完整订单簿、历史成交
 * 层级 3: 链上 - 最终结算数据（通过 ethers.js 同步）
 */

// 订单状态
export type OrderStatus = 'pending' | 'partial' | 'matched' | 'settled' | 'cancelled'

// 扩展订单类型（包含状态）
export interface StoredOrder extends Order {
  status: OrderStatus
  filledAmount: string
  createdAt: number
  updatedAt: number
}

// 撮合记录
export interface Match {
  matchId: string
  orderId: string
  taker: string
  filledAmount: string
  price: string
  timestamp: number
  txHash?: string // 链上交易哈希
}

// 链上成交记录（从事件同步）
export interface OnChainTrade extends Trade {
  blockNumber: number
  blockTimestamp: number
  confirmed: boolean
}

/**
 * P2P DEX 数据库
 * 使用 Dexie.js 封装 IndexedDB
 */
class P2PDEXDatabase extends Dexie {
  // 表定义
  orders!: Table<StoredOrder, string>
  matches!: Table<Match, string>
  trades!: Table<OnChainTrade, string>

  constructor() {
    super('P2PDEX')
    
    this.version(1).stores({
      // 订单表：按 orderId 主键，索引 maker、status、timestamp
      orders: 'orderId, trader, pair, status, timestamp, createdAt',
      
      // 撮合记录表：按 matchId 主键，索引 orderId、timestamp
      matches: 'matchId, orderId, taker, timestamp',
      
      // 链上成交表：按 tradeId 主键，索引 pair、timestamp、txHash
      trades: 'tradeId, pair, maker, taker, timestamp, txHash, blockNumber',
    })
  }
}

// 全局数据库实例
const db = new P2PDEXDatabase()

/**
 * 订单管理
 */
export class OrderStorage {
  /**
   * 保存新订单
   */
  static async saveOrder(order: Order): Promise<void> {
    const storedOrder: StoredOrder = {
      ...order,
      status: 'pending',
      filledAmount: '0',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    
    await db.orders.put(storedOrder)
    console.log('💾 订单已保存:', order.orderId)
  }

  /**
   * 更新订单状态
   */
  static async updateOrderStatus(
    orderId: string,
    status: OrderStatus,
    filledAmount?: string
  ): Promise<void> {
    const updates: Partial<StoredOrder> = {
      status,
      updatedAt: Date.now(),
    }
    
    if (filledAmount !== undefined) {
      updates.filledAmount = filledAmount
    }
    
    await db.orders.update(orderId, updates)
    console.log('📝 订单状态已更新:', orderId, status)
  }

  /**
   * 获取订单
   */
  static async getOrder(orderId: string): Promise<StoredOrder | undefined> {
    return await db.orders.get(orderId)
  }

  /**
   * 获取用户的所有订单
   */
  static async getUserOrders(
    trader: string,
    status?: OrderStatus
  ): Promise<StoredOrder[]> {
    let query = db.orders.where('trader').equals(trader)
    
    if (status) {
      query = query.and(order => order.status === status)
    }
    
    return await query.reverse().sortBy('createdAt')
  }

  /**
   * 获取交易对的活跃订单
   */
  static async getActiveOrders(pair: string): Promise<StoredOrder[]> {
    return await db.orders
      .where('pair').equals(pair)
      .and(order => order.status === 'pending' || order.status === 'partial')
      .sortBy('createdAt')
  }

  /**
   * 获取所有活跃订单（任意交易对，用于节点启动时恢复订单簿）
   */
  static async getAllActiveOrders(): Promise<StoredOrder[]> {
    return await db.orders
      .filter(order => order.status === 'pending' || order.status === 'partial')
      .sortBy('createdAt')
  }

  /**
   * 删除订单
   */
  static async deleteOrder(orderId: string): Promise<void> {
    await db.orders.delete(orderId)
    console.log('🗑️ 订单已删除:', orderId)
  }

  /**
   * 清理旧订单（保留最近 N 天）
   */
  static async cleanupOldOrders(daysToKeep = 30): Promise<number> {
    const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000
    
    const oldOrders = await db.orders
      .where('createdAt').below(cutoffTime)
      .and(order => order.status === 'settled' || order.status === 'cancelled')
      .toArray()
    
    await db.orders.bulkDelete(oldOrders.map(o => o.orderId))
    
    console.log(`🧹 已清理 ${oldOrders.length} 个旧订单`)
    return oldOrders.length
  }
}

/**
 * 撮合记录管理
 */
export class MatchStorage {
  /**
   * 保存撮合记录
   */
  static async saveMatch(match: Match): Promise<void> {
    await db.matches.put(match)
    console.log('💾 撮合记录已保存:', match.matchId)
  }

  /**
   * 更新撮合的交易哈希
   */
  static async updateMatchTxHash(matchId: string, txHash: string): Promise<void> {
    await db.matches.update(matchId, { txHash })
    console.log('📝 撮合交易哈希已更新:', matchId, txHash)
  }

  /**
   * 获取订单的所有撮合记录
   */
  static async getOrderMatches(orderId: string): Promise<Match[]> {
    return await db.matches
      .where('orderId').equals(orderId)
      .reverse()
      .sortBy('timestamp')
  }

  /**
   * 获取用户的撮合记录
   */
  static async getUserMatches(taker: string): Promise<Match[]> {
    return await db.matches
      .where('taker').equals(taker)
      .reverse()
      .sortBy('timestamp')
  }
}

/**
 * 撮合后持久化：保存 Match 并更新 maker 订单状态（filledAmount / settled）
 * 供 OrderSubscriber 在本地撮合成功时调用
 */
export async function saveMatchAndUpdateMaker(trade: Trade, txHash?: string): Promise<void> {
  const match: Match = {
    matchId: trade.tradeId,
    orderId: trade.makerOrderId,
    taker: trade.taker,
    filledAmount: trade.amount,
    price: trade.price,
    timestamp: trade.timestamp,
    txHash,
  }
  await db.matches.put(match)
  console.log('💾 撮合记录已保存:', match.matchId)

  const maker = await db.orders.get(trade.makerOrderId)
  if (!maker) return
  const newFilled = parseFloat(maker.filledAmount) + parseFloat(trade.amount)
  const status: OrderStatus =
    newFilled >= parseFloat(maker.amount) ? 'settled' : 'partial'
  await OrderStorage.updateOrderStatus(trade.makerOrderId, status, newFilled.toString())
}

/**
 * 链上成交管理
 */
export class TradeStorage {
  /**
   * 保存链上成交记录
   */
  static async saveTrade(trade: OnChainTrade): Promise<void> {
    await db.trades.put(trade)
    console.log('💾 链上成交已保存:', trade.tradeId)
  }

  /**
   * 批量保存链上成交
   */
  static async saveTrades(trades: OnChainTrade[]): Promise<void> {
    await db.trades.bulkPut(trades)
    console.log(`💾 批量保存 ${trades.length} 条链上成交`)
  }

  /**
   * 获取交易对的成交历史
   */
  static async getTradesByPair(pair: string, limit = 50): Promise<OnChainTrade[]> {
    return await db.trades
      .where('pair').equals(pair)
      .reverse()
      .sortBy('timestamp')
      .then(trades => trades.slice(0, limit))
  }

  /**
   * 获取用户的成交历史
   */
  static async getUserTrades(address: string, limit = 50): Promise<OnChainTrade[]> {
    const trades = await db.trades
      .filter(trade => 
        trade.maker.toLowerCase() === address.toLowerCase() ||
        trade.taker.toLowerCase() === address.toLowerCase()
      )
      .reverse()
      .sortBy('timestamp')
    
    return trades.slice(0, limit)
  }

  /**
   * 通过交易哈希获取成交
   */
  static async getTradeByTxHash(txHash: string): Promise<OnChainTrade | undefined> {
    return await db.trades.where('txHash').equals(txHash).first()
  }

  /**
   * 标记成交为已确认
   */
  static async confirmTrade(tradeId: string): Promise<void> {
    await db.trades.update(tradeId, { confirmed: true })
    console.log('✅ 成交已确认:', tradeId)
  }

  /**
   * 清理旧成交（保留最近 N 天）
   */
  static async cleanupOldTrades(daysToKeep = 90): Promise<number> {
    const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000
    
    const oldTrades = await db.trades
      .where('timestamp').below(cutoffTime)
      .toArray()
    
    await db.trades.bulkDelete(oldTrades.map(t => t.tradeId))
    
    console.log(`🧹 已清理 ${oldTrades.length} 条旧成交`)
    return oldTrades.length
  }
}

/**
 * 数据库管理
 */
export class DatabaseManager {
  /**
   * 初始化数据库
   */
  static async init(): Promise<void> {
    try {
      await db.open()
      console.log('✅ 数据库已初始化')
    } catch (error) {
      console.error('❌ 数据库初始化失败:', error)
      throw error
    }
  }

  /**
   * 获取数据库统计信息
   */
  static async getStats() {
    const [orderCount, matchCount, tradeCount] = await Promise.all([
      db.orders.count(),
      db.matches.count(),
      db.trades.count(),
    ])
    
    return {
      orders: orderCount,
      matches: matchCount,
      trades: tradeCount,
    }
  }

  /**
   * 清理所有旧数据
   */
  static async cleanup(daysToKeep = 30): Promise<void> {
    const [orders, trades] = await Promise.all([
      OrderStorage.cleanupOldOrders(daysToKeep),
      TradeStorage.cleanupOldTrades(daysToKeep * 3), // 成交保留更久
    ])
    
    console.log(`🧹 清理完成: ${orders} 个订单, ${trades} 条成交`)
  }

  /**
   * 导出数据（备份）
   */
  static async exportData() {
    const [orders, matches, trades] = await Promise.all([
      db.orders.toArray(),
      db.matches.toArray(),
      db.trades.toArray(),
    ])
    
    return {
      version: 1,
      exportedAt: Date.now(),
      data: { orders, matches, trades },
    }
  }

  /**
   * 导入数据（恢复）
   */
  static async importData(data: any): Promise<void> {
    if (data.version !== 1) {
      throw new Error('不支持的数据版本')
    }
    
    await db.transaction('rw', [db.orders, db.matches, db.trades], async () => {
      if (data.data.orders) {
        await db.orders.bulkPut(data.data.orders)
      }
      if (data.data.matches) {
        await db.matches.bulkPut(data.data.matches)
      }
      if (data.data.trades) {
        await db.trades.bulkPut(data.data.trades)
      }
    })
    
    console.log('✅ 数据导入完成')
  }

  /**
   * 清空所有数据
   */
  static async clearAll(): Promise<void> {
    await db.transaction('rw', [db.orders, db.matches, db.trades], async () => {
      await db.orders.clear()
      await db.matches.clear()
      await db.trades.clear()
    })
    
    console.log('🗑️ 所有数据已清空')
  }

  /**
   * 关闭数据库
   */
  static async close(): Promise<void> {
    await db.close()
    console.log('📦 数据库已关闭')
  }
}

// 导出数据库实例（供高级用户使用）
export { db }

// 兼容旧的 p2pStorage 接口
export const p2pStorage = {
  init: DatabaseManager.init,
  saveOrder: OrderStorage.saveOrder,
  getOrder: OrderStorage.getOrder,
  getAllActiveOrders: OrderStorage.getAllActiveOrders,
  deleteOrder: OrderStorage.deleteOrder,
  saveMatchAndUpdateMaker,
  saveTrade: TradeStorage.saveTrade,
  getTradesByPair: TradeStorage.getTradesByPair,
  cleanup: DatabaseManager.cleanup,
  close: DatabaseManager.close,
}
