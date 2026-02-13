/**
 * P2P 订单广播：Bootstrap + DHT 发现，GossipSub 发布/订阅 bite100/orders
 * 与 nodePost + relay WS 并存：挂单时先 nodePost，再 P2P 广播；peer 少时仍依赖节点 API/relay。
 */
import type { Libp2p } from 'libp2p'
import type { GossipSub } from '@libp2p/gossipsub'
import { createBrowserP2PNode, ORDERS_TOPIC } from './node'

/** 广播的订单 payload（与节点 API 一致） */
export interface SignedOrderPayload {
  orderId: string
  trader: string
  pair: string
  side: 'buy' | 'sell'
  price: string
  amount: string
  filled: string
  status: string
  nonce: number
  createdAt: number
  expiresAt: number
  signature: string
}

const MIN_PEERS_FOR_P2P = 2

class P2POrderBroadcastService {
  private node: Libp2p | null = null
  private listeners = new Set<(order: SignedOrderPayload) => void>()
  private _startPromise: Promise<Libp2p | null> | null = null

  /** 当前 peer 数 */
  getPeersCount(): number {
    if (!this.node) return 0
    return this.node.getPeers().length
  }

  /** 是否可用（已启动且至少有 MIN_PEERS_FOR_P2P 个 peer，可选：少时也可发布） */
  isReady(): boolean {
    return this.node != null
  }

  /** 建议是否用 P2P 广播（peer 足够时 true；少时调用方仍可 fallback 到仅 nodePost + relay） */
  shouldUseP2P(): boolean {
    return this.isReady() && this.getPeersCount() >= MIN_PEERS_FOR_P2P
  }

  /** 启动节点并订阅订单 topic（幂等） */
  async start(): Promise<Libp2p | null> {
    if (this.node) return this.node
    if (this._startPromise) return this._startPromise
    this._startPromise = (async () => {
      try {
        const node = await createBrowserP2PNode()
        this.node = node
        const pubsub = node.services.pubsub as GossipSub | undefined
        if (pubsub) {
          const onMessage = (ev: Event) => {
            const e = ev as CustomEvent<{ msg?: { data?: Uint8Array }; data?: Uint8Array }>
            const data = e.detail?.msg?.data ?? e.detail?.data
            if (!data) return
            try {
              const json = new TextDecoder().decode(data)
              const order = JSON.parse(json) as SignedOrderPayload
              if (order?.orderId && order?.pair) this.listeners.forEach((cb) => cb(order))
            } catch {
              /* ignore */
            }
          }
          pubsub.addEventListener('message', onMessage)
          pubsub.addEventListener('gossipsub:message', onMessage)
          pubsub.subscribe(ORDERS_TOPIC)
        }
        return node
      } catch (e) {
        console.warn('[P2P] 启动失败，将仅使用节点 API + relay:', e)
        this._startPromise = null
        return null
      }
    })()
    return this._startPromise
  }

  /** 订阅收到的订单（用于刷新订单簿） */
  addOrderListener(cb: (order: SignedOrderPayload) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** 向 GossipSub 发布订单（已启动时调用；否则 no-op） */
  async publishOrder(order: SignedOrderPayload): Promise<boolean> {
    if (!this.node) return false
    const pubsub = this.node.services.pubsub as GossipSub | undefined
    if (!pubsub) return false
    try {
      const data = new TextEncoder().encode(JSON.stringify(order))
      await pubsub.publish(ORDERS_TOPIC, data)
      return true
    } catch {
      return false
    }
  }

  /** 停止并清理 */
  async stop(): Promise<void> {
    if (this.node) {
      try {
        const pubsub = this.node.services.pubsub as GossipSub | undefined
        if (pubsub) pubsub.unsubscribe(ORDERS_TOPIC)
        await this.node.stop()
      } catch {}
      this.node = null
    }
    this._startPromise = null
    this.listeners.clear()
  }
}

export const p2pOrderBroadcast = new P2POrderBroadcastService()
