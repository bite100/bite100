import { Libp2p } from 'libp2p'
import { P2P_CONFIG } from '../config'
import { createP2PNode } from './node'
import { OrderPublisher } from './orderPublisher'
import { OrderSubscriber } from './orderSubscriber'
import { MatchEngine } from './matchEngine'
import { DatabaseManager, OrderStorage } from './storage'
import { isBridgeAvailable, createBridgePublisher, startBridgeSubscriber } from './electronBridge'

/**
 * P2P 管理器（单例）
 * 管理节点生命周期、订单发布/订阅、撮合引擎
 */
/** 定时器 ID（用于 stop 时清理） */
const MS_PER_DAY = 24 * 60 * 60 * 1000
const MS_PER_MINUTE = 60 * 1000

export class P2PManager {
  private node: Libp2p | null = null
  private publisher: OrderPublisher | ReturnType<typeof createBridgePublisher> | null = null
  private subscriber: OrderSubscriber | null = null
  private matchEngine: MatchEngine | null = null
  private isStarted = false
  private storageEnabled = false
  private bridgeMode = false
  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null
  private statsIntervalId: ReturnType<typeof setInterval> | null = null

  /**
   * 启动 P2P 节点
   * @param enableStorage 是否启用 IndexedDB 持久化（默认关闭）
   */
  async start(enableStorage = false) {
    if (this.isStarted) {
      console.log('⚠️ P2P 节点已启动')
      return
    }

    console.log('🚀 启动客户端 P2P 节点...')

    try {
      if (enableStorage) {
        await DatabaseManager.init()
        this.storageEnabled = true
        console.log('💾 IndexedDB 持久化已启用')
      }

      this.matchEngine = new MatchEngine()

      if (this.storageEnabled) {
        const activeOrders = await OrderStorage.getAllActiveOrders()
        for (const order of activeOrders) {
          this.matchEngine!.addOrder(order)
        }
        console.log(`📦 从本地恢复 ${activeOrders.length} 个活跃订单到订单簿`)
      }

      if (isBridgeAvailable()) {
        this.bridgeMode = true
        this.publisher = createBridgePublisher()
        startBridgeSubscriber(this.matchEngine, this.storageEnabled, this.publisher)
        this.isStarted = true
        console.log('✅ P2P 桥接模式已启动（Electron → Go 节点）')
      } else {
        this.node = await createP2PNode({
          bootstrapList: P2P_CONFIG.BOOTSTRAP_PEERS.length > 0 ? P2P_CONFIG.BOOTSTRAP_PEERS : undefined,
        })
        this.publisher = new OrderPublisher(this.node)
        this.subscriber = new OrderSubscriber(this.node, this.matchEngine, this.storageEnabled, this.publisher)
        await this.subscriber.start()
        this.isStarted = true
        console.log('✅ P2P 节点启动成功')
      }
      
      if (this.node) {
        this.node.addEventListener('peer:connect', (evt) => {
          const peerId = evt.detail.toString()
          console.log('🔗 已连接到 peer:', peerId.slice(0, 8) + '...')
          window.dispatchEvent(new CustomEvent('p2p-peer-connect', { detail: { peerId } }))
        })
        this.node.addEventListener('peer:disconnect', (evt) => {
          const peerId = evt.detail.toString()
          console.log('❌ peer 断开:', peerId.slice(0, 8) + '...')
          window.dispatchEvent(new CustomEvent('p2p-peer-disconnect', { detail: { peerId } }))
        })
      }

      // 定期清理旧数据（如果启用了存储）
      if (this.storageEnabled) {
        this.cleanupIntervalId = setInterval(() => {
          DatabaseManager.cleanup(30) // 订单保留 30 天，成交保留 90 天
        }, MS_PER_DAY)
      }

      // 打印统计信息
      this.statsIntervalId = setInterval(() => {
        const stats = this.matchEngine?.getStats()
        if (stats) {
          console.log(`📊 统计: ${stats.pairs} 个交易对, ${stats.orders} 个订单`)
        }
      }, MS_PER_MINUTE)
    } catch (error) {
      console.error('❌ 启动 P2P 节点失败:', error)
      throw error
    }
  }

  /**
   * 停止 P2P 节点
   */
  async stop() {
    if (!this.isStarted) return

    console.log('🛑 停止 P2P 节点...')

    if (this.cleanupIntervalId != null) {
      clearInterval(this.cleanupIntervalId)
      this.cleanupIntervalId = null
    }
    if (this.statsIntervalId != null) {
      clearInterval(this.statsIntervalId)
      this.statsIntervalId = null
    }

    await this.subscriber?.stop()
    await this.node?.stop()

    if (this.storageEnabled) {
      await DatabaseManager.close()
    }

    this.node = null
    this.publisher = null
    this.subscriber = null
    this.matchEngine = null
    this.isStarted = false
    this.storageEnabled = false
    this.bridgeMode = false

    console.log('✅ P2P 节点已停止')
  }

  /**
   * 获取 libp2p 节点实例
   */
  getNode() {
    return this.node
  }

  /**
   * 获取订单发布器
   */
  getPublisher() {
    return this.publisher
  }

  /**
   * 获取撮合引擎
   */
  getMatchEngine() {
    return this.matchEngine
  }

  /**
   * 获取节点 ID
   */
  getPeerId() {
    if (this.bridgeMode) return 'bridge'
    return this.node?.peerId.toString()
  }

  /**
   * 获取连接的 peer 数量
   */
  getPeerCount() {
    if (this.bridgeMode) return 1
    return this.node?.getPeers().length ?? 0
  }

  /**
   * 检查节点是否已启动（含桥接模式）
   */
  isReady() {
    return this.isStarted && (this.node !== null || this.bridgeMode)
  }

  /**
   * 检查是否启用了持久化存储
   */
  isStorageEnabled() {
    return this.storageEnabled
  }

  /**
   * 获取节点统计信息
   */
  getStats() {
    return {
      isStarted: this.isStarted,
      peerId: this.getPeerId(),
      peerCount: this.getPeerCount(),
      storageEnabled: this.storageEnabled,
      matchEngine: this.matchEngine?.getStats(),
    }
  }
}

// 全局单例
export const p2pManager = new P2PManager()
