/**
 * Electron 内置 P2P 桥接：renderer 通过 IPC 与 main 进程通信，main 连 Go 节点 WebSocket (ws://localhost:9000)
 * 当 window.electronP2P 存在时使用桥接模式，否则使用 JS-libp2p
 */
import { Order, CancelRequest, Trade, TOPICS } from './types'
import { OrderStorage, TradeStorage, saveMatchAndUpdateMaker } from './storage'
import { MatchEngine } from './matchEngine'
import type { OrderPublisher } from './orderPublisher'

// 类型定义已移至 src/types/electron.d.ts

export function isBridgeAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.electronP2P?.isAvailable
}

/** 通过 IPC 发送到 main → WebSocket 到 Go 节点 */
export function createBridgePublisher(): Pick<OrderPublisher, 'publishOrder' | 'publishCancel' | 'publishTrade'> {
  const send = (topic: string, payload: string) => {
    window.electronP2P?.send(topic, payload)
  }
  return {
    publishOrder: (order: Order) => send(TOPICS.ORDER_NEW, JSON.stringify(order)),
    publishCancel: (cancel: CancelRequest) => send(TOPICS.ORDER_CANCEL, JSON.stringify(cancel)),
    publishTrade: (trade: Trade) => send(TOPICS.TRADE_EXECUTED, JSON.stringify(trade)),
  }
}

/**
 * 订阅 main 进程转发的消息，与 OrderSubscriber 逻辑一致：存 DB、入簿、撮合、广播 Match、尝试结算
 */
export function startBridgeSubscriber(
  matchEngine: MatchEngine,
  storageEnabled: boolean,
  publisher: Pick<OrderPublisher, 'publishOrder' | 'publishCancel' | 'publishTrade'> | null
): void {
  window.electronP2P?.onMessage((msg) => {
    const topic = msg?.topic
    const raw = typeof msg?.data === 'string' ? msg.data : ''
    if (!raw) return

    if (topic === TOPICS.ORDER_NEW) {
      try {
        const order: Order = JSON.parse(raw)
        console.log('📥 [桥接] 收到新订单:', order.orderId)
        if (storageEnabled) OrderStorage.saveOrder(order)
        matchEngine.addOrder(order)
        const trades = matchEngine.match(order)
        if (trades.length > 0) {
          for (const t of trades) {
            publisher?.publishTrade(t)
            if (storageEnabled) saveMatchAndUpdateMaker(t)
            window.dispatchEvent(new CustomEvent('match-for-settlement', { detail: t }))
          }
        }
      } catch (e) {
        console.error('❌ [桥接] 处理新订单失败', e)
      }
      return
    }

    if (topic === TOPICS.ORDER_CANCEL) {
      try {
        const cancel: CancelRequest = JSON.parse(raw)
        console.log('📥 [桥接] 收到撤单:', cancel.orderId)
        matchEngine.removeOrder(cancel.orderId)
        if (storageEnabled) OrderStorage.updateOrderStatus(cancel.orderId, 'cancelled')
      } catch (e) {
        console.error('❌ [桥接] 处理撤单失败', e)
      }
      return
    }

    if (topic === TOPICS.TRADE_EXECUTED) {
      try {
        const trade: Trade = JSON.parse(raw)
        console.log('📥 [桥接] 收到成交:', trade.tradeId)
        if (storageEnabled) {
          TradeStorage.saveTrade({
            ...trade,
            blockNumber: 0,
            blockTimestamp: 0,
            confirmed: false,
          })
        }
        window.dispatchEvent(new CustomEvent('trade-executed', { detail: trade }))
      } catch (e) {
        console.error('❌ [桥接] 处理成交失败', e)
      }
    }
  })
  console.log('✅ P2P 桥接订阅已启动')
}
