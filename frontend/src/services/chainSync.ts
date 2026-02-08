import { ethers } from 'ethers'
import { TradeStorage, OrderStorage, type OnChainTrade } from '../p2p/storage'

/**
 * 链上事件同步服务
 * 监听 Settlement 合约事件，同步链上成交到 IndexedDB
 */

// Settlement 合约 ABI（仅包含需要的事件）
const SETTLEMENT_ABI = [
  'event TradeSettled(address indexed maker, address indexed taker, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 feeAmount)',
  'event TradeSettledWithGasReimburse(address indexed maker, address indexed taker, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 feeAmount, uint256 gasReimburseIn, uint256 gasReimburseOut, address indexed gasRecipient)',
]

export class ChainSyncService {
  private provider: ethers.Provider | null = null
  private settlementContract: ethers.Contract | null = null
  private isListening = false
  private listeners: Array<() => void> = []

  /**
   * 初始化链上同步服务
   * @param provider ethers.js Provider
   * @param settlementAddress Settlement 合约地址
   */
  async init(provider: ethers.Provider, settlementAddress: string) {
    this.provider = provider
    this.settlementContract = new ethers.Contract(
      settlementAddress,
      SETTLEMENT_ABI,
      provider
    )
    
    console.log('✅ 链上同步服务已初始化')
  }

  /**
   * 开始监听链上事件
   */
  async startListening() {
    if (!this.settlementContract || this.isListening) return
    
    console.log('👂 开始监听链上成交事件...')
    
    // 监听 TradeSettled 事件
    const tradeSettledListener = async (
      maker: string,
      taker: string,
      tokenIn: string,
      tokenOut: string,
      amountIn: bigint,
      amountOut: bigint,
      _feeAmount: bigint,
      event: ethers.EventLog
    ) => {
      await this.handleTradeEvent(
        maker,
        taker,
        tokenIn,
        tokenOut,
        amountIn,
        amountOut,
        event
      )
    }
    
    // 监听 TradeSettledWithGasReimburse 事件
    const tradeWithGasListener = async (
      maker: string,
      taker: string,
      tokenIn: string,
      tokenOut: string,
      amountIn: bigint,
      amountOut: bigint,
      _feeAmount: bigint,
      _gasReimburseIn: bigint,
      _gasReimburseOut: bigint,
      _gasRecipient: string,
      event: ethers.EventLog
    ) => {
      await this.handleTradeEvent(
        maker,
        taker,
        tokenIn,
        tokenOut,
        amountIn,
        amountOut,
        event
      )
    }
    
    this.settlementContract.on('TradeSettled', tradeSettledListener)
    this.settlementContract.on('TradeSettledWithGasReimburse', tradeWithGasListener)
    
    this.listeners.push(
      () => this.settlementContract?.off('TradeSettled', tradeSettledListener),
      () => this.settlementContract?.off('TradeSettledWithGasReimburse', tradeWithGasListener)
    )
    
    this.isListening = true
    console.log('✅ 链上事件监听已启动')
  }

  /**
   * 停止监听
   */
  stopListening() {
    if (!this.isListening) return
    
    this.listeners.forEach(unsubscribe => unsubscribe())
    this.listeners = []
    this.isListening = false
    
    console.log('🛑 链上事件监听已停止')
  }

  /**
   * 处理链上成交事件
   */
  private async handleTradeEvent(
    maker: string,
    taker: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    amountOut: bigint,
    event: ethers.EventLog
  ) {
    try {
      const block = await event.getBlock()
      const txHash = event.transactionHash
      
      // 推断交易对（简化版，实际需要 token registry）
      const pair = `${tokenIn.slice(0, 6)}.../${tokenOut.slice(0, 6)}...`
      
      // 生成 tradeId（使用 txHash + logIndex）
      const tradeId = `${txHash}-${event.index}`
      
      const trade: OnChainTrade = {
        tradeId,
        makerOrderId: '', // 链上事件没有 orderId，留空
        takerOrderId: '',
        maker: maker.toLowerCase(),
        taker: taker.toLowerCase(),
        pair,
        price: (Number(amountOut) / Number(amountIn)).toString(),
        amount: amountIn.toString(),
        timestamp: block.timestamp * 1000, // 转为毫秒
        txHash,
        blockNumber: block.number,
        blockTimestamp: block.timestamp,
        confirmed: true,
      }
      
      // 保存到 IndexedDB
      await TradeStorage.saveTrade(trade)
      
      console.log('💾 链上成交已同步:', tradeId)
      
      // 触发 UI 更新
      window.dispatchEvent(new CustomEvent('chain-trade-synced', {
        detail: trade
      }))
      
      // 更新相关订单状态为 settled（如果能找到）
      // 注意：链上事件没有 orderId，需要通过 maker/taker + amount 匹配
      await this.updateRelatedOrders(maker, taker, amountIn.toString())
    } catch (error) {
      console.error('❌ 处理链上成交事件失败:', error)
    }
  }

  /**
   * 更新相关订单状态
   */
  private async updateRelatedOrders(
    maker: string,
    _taker: string,
    amount: string
  ) {
    try {
      // 查找 maker 的待结算订单
      const makerOrders = await OrderStorage.getUserOrders(maker.toLowerCase(), 'matched')
      
      for (const order of makerOrders) {
        if (order.amount === amount) {
          await OrderStorage.updateOrderStatus(order.orderId, 'settled')
          console.log('📝 订单状态已更新为 settled:', order.orderId)
          break
        }
      }
    } catch (error) {
      console.error('❌ 更新订单状态失败:', error)
    }
  }

  /**
   * 同步历史成交（从指定区块到当前）
   * @param fromBlock 起始区块（默认最近 10000 个区块）
   * @param userAddress 用户地址（可选，过滤用户相关的成交）
   */
  async syncHistoricalTrades(fromBlock?: number, userAddress?: string) {
    if (!this.settlementContract || !this.provider) {
      throw new Error('链上同步服务未初始化')
    }
    
    const currentBlock = await this.provider.getBlockNumber()
    const startBlock = fromBlock ?? Math.max(0, currentBlock - 10000)
    
    console.log(`🔄 同步历史成交: 区块 ${startBlock} -> ${currentBlock}`)
    
    try {
      // 构建过滤器
      const filter1 = this.settlementContract.filters.TradeSettled(
        userAddress ? userAddress : null,
        userAddress ? userAddress : null
      )
      
      const filter2 = this.settlementContract.filters.TradeSettledWithGasReimburse(
        userAddress ? userAddress : null,
        userAddress ? userAddress : null
      )
      
      // 查询事件
      const [events1, events2] = await Promise.all([
        this.settlementContract.queryFilter(filter1, startBlock, currentBlock),
        this.settlementContract.queryFilter(filter2, startBlock, currentBlock),
      ])
      
      const allEvents = [...events1, ...events2].sort((a, b) => 
        a.blockNumber - b.blockNumber
      )
      
      console.log(`📦 找到 ${allEvents.length} 条历史成交`)
      
      // 批量处理
      const trades: OnChainTrade[] = []
      
      for (const event of allEvents) {
        const block = await event.getBlock()
        
        // 类型断言为 EventLog 以访问 args
        if (!(event instanceof ethers.EventLog)) continue
        const args = event.args
        
        if (!args) continue
        
        const pair = `${args.tokenIn.slice(0, 6)}.../${args.tokenOut.slice(0, 6)}...`
        const tradeId = `${event.transactionHash}-${event.index}`
        
        trades.push({
          tradeId,
          makerOrderId: '',
          takerOrderId: '',
          maker: args.maker.toLowerCase(),
          taker: args.taker.toLowerCase(),
          pair,
          price: (Number(args.amountOut) / Number(args.amountIn)).toString(),
          amount: args.amountIn.toString(),
          timestamp: block.timestamp * 1000,
          txHash: event.transactionHash,
          blockNumber: block.number,
          blockTimestamp: block.timestamp,
          confirmed: true,
        })
      }
      
      // 批量保存
      if (trades.length > 0) {
        await TradeStorage.saveTrades(trades)
        console.log(`✅ 已同步 ${trades.length} 条历史成交`)
      }
      
      return trades
    } catch (error) {
      console.error('❌ 同步历史成交失败:', error)
      throw error
    }
  }

  /**
   * 获取最新同步的区块号
   */
  async getLatestSyncedBlock(): Promise<number> {
    // 从 localStorage 读取
    const stored = localStorage.getItem('lastSyncedBlock')
    return stored ? parseInt(stored) : 0
  }

  /**
   * 保存最新同步的区块号
   */
  async saveLatestSyncedBlock(blockNumber: number) {
    localStorage.setItem('lastSyncedBlock', blockNumber.toString())
  }

  /**
   * 增量同步（从上次同步位置到当前）
   */
  async incrementalSync(userAddress?: string) {
    const lastBlock = await this.getLatestSyncedBlock()
    const trades = await this.syncHistoricalTrades(lastBlock + 1, userAddress)
    
    if (trades.length > 0) {
      const latestBlock = Math.max(...trades.map(t => t.blockNumber))
      await this.saveLatestSyncedBlock(latestBlock)
    }
    
    return trades
  }
}

// 全局单例
export const chainSyncService = new ChainSyncService()
