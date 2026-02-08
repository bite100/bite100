import type { Libp2p } from 'libp2p'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { Order, CancelRequest, Trade, TOPICS } from './types'
import { MatchEngine } from './matchEngine'
import { OrderPublisher } from './orderPublisher'
import { OrderStorage, TradeStorage, saveMatchAndUpdateMaker } from './storage'

/** Gossipsub 消息：detail 含 topic 与 data */
interface PubSubMessageDetail {
  topic: string
  data: Uint8Array
}

interface PubSubLike {
  subscribe(topic: string): void
  unsubscribe(topic: string): void
  addEventListener(type: 'message', fn: (evt: CustomEvent<PubSubMessageDetail>) => void): void
  removeEventListener(type: 'message', fn: (evt: CustomEvent<PubSubMessageDetail>) => void): void
}

function getPubsub(node: Libp2p): PubSubLike {
  const pubsub = (node.services as { pubsub?: PubSubLike }).pubsub
  if (!pubsub) throw new Error('PubSub not available')
  return pubsub
}

/**
 * 订单订阅器
 * 监听 P2P 网络的订单消息并处理
 * 支持可选的 IndexedDB 持久化；撮合成功后通过 publisher 广播成交
 */
export class OrderSubscriber {
  private subscriptions = new Map<string, () => void>()

  constructor(
    private node: Libp2p,
    private matchEngine: MatchEngine,
    private storageEnabled: boolean = false,
    private publisher: OrderPublisher | null = null
  ) {}

  /**
   * 启动订阅
   */
  async start() {
    await this.subscribeOrderNew()
    await this.subscribeOrderCancel()
    await this.subscribeTradeExecuted()
    
    console.log('✅ 订单订阅器已启动')
  }

  /**
   * 停止订阅
   */
  async stop() {
    for (const unsubscribe of this.subscriptions.values()) {
      unsubscribe()
    }
    this.subscriptions.clear()
    console.log('🛑 订单订阅器已停止')
  }

  /**
   * 订阅新订单
   */
  private async subscribeOrderNew() {
    const pubsub = getPubsub(this.node)
    pubsub.subscribe(TOPICS.ORDER_NEW)

    const handler = async (evt: CustomEvent<PubSubMessageDetail>) => {
      if (evt.detail?.topic !== TOPICS.ORDER_NEW) return
      try {
        const data = uint8ArrayToString(evt.detail.data)
        const order: Order = JSON.parse(data)
        console.log('📥 收到新订单:', order.orderId)
        if (this.storageEnabled) await OrderStorage.saveOrder(order)
        this.matchEngine.addOrder(order)
        const trades = this.matchEngine.match(order)
        if (trades.length > 0) {
          await Promise.all(
            trades.map(async (t) => {
              await this.publisher?.publishTrade(t)
              if (this.storageEnabled) await saveMatchAndUpdateMaker(t)
              window.dispatchEvent(new CustomEvent('match-for-settlement', { detail: t }))
            })
          )
        }
      } catch (error) {
        console.error('❌ 处理新订单失败:', error)
      }
    }

    pubsub.addEventListener('message', handler)
    this.subscriptions.set(TOPICS.ORDER_NEW, () => {
      pubsub.removeEventListener('message', handler)
      pubsub.unsubscribe(TOPICS.ORDER_NEW)
    })
  }

  /**
   * 订阅取消订单
   */
  private async subscribeOrderCancel() {
    const pubsub = getPubsub(this.node)
    pubsub.subscribe(TOPICS.ORDER_CANCEL)

    const handler = async (evt: CustomEvent<PubSubMessageDetail>) => {
      if (evt.detail?.topic !== TOPICS.ORDER_CANCEL) return
      try {
        const data = uint8ArrayToString(evt.detail.data)
        const cancel: CancelRequest = JSON.parse(data)
        console.log('📥 收到撤单:', cancel.orderId)
        this.matchEngine.removeOrder(cancel.orderId)
        if (this.storageEnabled) await OrderStorage.updateOrderStatus(cancel.orderId, 'cancelled')
      } catch (error) {
        console.error('❌ 处理撤单失败:', error)
      }
    }

    pubsub.addEventListener('message', handler)
    this.subscriptions.set(TOPICS.ORDER_CANCEL, () => {
      pubsub.removeEventListener('message', handler)
      pubsub.unsubscribe(TOPICS.ORDER_CANCEL)
    })
  }

  /**
   * 订阅成交通知
   */
  private async subscribeTradeExecuted() {
    const pubsub = getPubsub(this.node)
    pubsub.subscribe(TOPICS.TRADE_EXECUTED)

    const handler = async (evt: CustomEvent<PubSubMessageDetail>) => {
      if (evt.detail?.topic !== TOPICS.TRADE_EXECUTED) return
      try {
        const data = uint8ArrayToString(evt.detail.data)
        const trade: Trade = JSON.parse(data)
        console.log('📥 收到成交:', trade.tradeId)
        if (this.storageEnabled) {
          await TradeStorage.saveTrade({
            ...trade,
            blockNumber: 0,
            blockTimestamp: 0,
            confirmed: false,
          })
        }
        window.dispatchEvent(new CustomEvent('trade-executed', { detail: trade }))
      } catch (error) {
        console.error('❌ 处理成交失败:', error)
      }
    }

    pubsub.addEventListener('message', handler)
    this.subscriptions.set(TOPICS.TRADE_EXECUTED, () => {
      pubsub.removeEventListener('message', handler)
      pubsub.unsubscribe(TOPICS.TRADE_EXECUTED)
    })
  }
}
