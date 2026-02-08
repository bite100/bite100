import type { Libp2p } from 'libp2p'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { Order, CancelRequest, Trade, TOPICS } from './types'

/** PubSub 接口（libp2p services.pubsub 运行时存在，类型由各实现提供） */
interface PubSubLike {
  publish(topic: string, data?: Uint8Array): Promise<{ recipients: unknown[] }>
}

function getPubsub(node: Libp2p): PubSubLike {
  const pubsub = (node.services as { pubsub?: PubSubLike }).pubsub
  if (!pubsub) throw new Error('PubSub not available')
  return pubsub
}

/**
 * 订单发布器
 * 使用 JSON 序列化（比 Protobuf 减小 20% bundle 大小）
 */
export class OrderPublisher {
  constructor(private node: Libp2p) {}

  async publishOrder(order: Order): Promise<void> {
    const pubsub = getPubsub(this.node)
    const json = JSON.stringify(order)
    const data = uint8ArrayFromString(json)
    await pubsub.publish(TOPICS.ORDER_NEW, data)
    
    console.log('📤 已发布订单:', order.orderId, `(${data.length} bytes)`)
  }

  /**
   * 发布撤单请求
   */
  async publishCancel(cancel: CancelRequest): Promise<void> {
    const pubsub = getPubsub(this.node)
    const json = JSON.stringify(cancel)
    const data = uint8ArrayFromString(json)
    await pubsub.publish(TOPICS.ORDER_CANCEL, data)
    
    console.log('📤 已发布撤单:', cancel.orderId)
  }

  /**
   * 发布成交记录
   */
  async publishTrade(trade: Trade): Promise<void> {
    const pubsub = getPubsub(this.node)
    const json = JSON.stringify(trade)
    const data = uint8ArrayFromString(json)
    await pubsub.publish(TOPICS.TRADE_EXECUTED, data)
    
    console.log('📤 已发布成交:', trade.tradeId)
  }
}
