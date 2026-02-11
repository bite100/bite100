import { P2P_CONFIG } from '../config'

export type WSMessageType = 'orderbook_update' | 'trade' | 'order_status'

export interface WSMessage {
  type: WSMessageType
  pair?: string
  data: any
}

/** 连接状态：便于 UI 显示 */
export type WSConnectionStatus = 'disconnected' | 'connecting' | 'connected'

const MIN_RECONNECT_MS = 1000
const MAX_RECONNECT_MS = 30000

/** 多 relay fallback：按 RELAY_WS_URLS 列表依次尝试，断线后指数退避重连 */
export class P2PWebSocketClient {
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private listeners: Map<WSMessageType, Set<(data: any) => void>> = new Map()
  private statusListeners: Set<(status: WSConnectionStatus) => void> = new Set()
  private urls: string[]
  private currentIndex = 0
  private consecutiveFailures = 0
  private _disconnecting = false

  constructor(urls?: string[]) {
    this.urls = urls?.length ? urls : [P2P_CONFIG.WS_URL]
  }

  private get currentUrl(): string {
    return this.urls[this.currentIndex % this.urls.length]
  }

  private setStatus(status: WSConnectionStatus) {
    this.statusListeners.forEach(cb => cb(status))
  }

  /** 订阅连接状态变化 */
  onStatusChange(cb: (status: WSConnectionStatus) => void) {
    this.statusListeners.add(cb)
    return () => this.statusListeners.delete(cb)
  }

  /** 指数退避 + 随机 jitter，避免多客户端同时重连 */
  private getReconnectDelay(): number {
    const base = Math.min(MIN_RECONNECT_MS * Math.pow(2, this.consecutiveFailures), MAX_RECONNECT_MS)
    const jitter = base * 0.2 * (Math.random() - 0.5)
    return Math.round(base + jitter)
  }

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return

    this.setStatus('connecting')
    const url = this.currentUrl
    console.log('连接 P2P Relay WebSocket:', url, `(${this.currentIndex + 1}/${this.urls.length})`)
    this.ws = new WebSocket(url)

    this.ws.onopen = () => {
      this.consecutiveFailures = 0
      this.setStatus('connected')
      console.log('P2P WebSocket 已连接')
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
    }

    this.ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data)
        this.handleMessage(msg)
      } catch (error) {
        console.error('解析 WebSocket 消息失败:', error)
      }
    }

    this.ws.onerror = () => {
      // 错误时 onclose 会触发
    }

    this.ws.onclose = () => {
      this.ws = null
      this.setStatus('disconnected')
      if (this._disconnecting) return
      this.consecutiveFailures++
      const delay = this.getReconnectDelay()
      if (this.urls.length > 1) {
        this.currentIndex++
        console.log('WebSocket 断开，尝试下一个 relay，', Math.round(delay / 1000), '秒后...')
      } else {
        console.log('WebSocket 断开，', Math.round(delay / 1000), '秒后重连...')
      }
      this.reconnectTimer = setTimeout(() => this.connect(), delay)
    }
  }
  
  disconnect() {
    this._disconnecting = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.setStatus('disconnected')
    this.consecutiveFailures = 0
    this._disconnecting = false
  }
  
  /** 订阅消息：callback 收到完整 WSMessage（含 type、pair、data），便于按 pair 过滤 */
  subscribe(type: WSMessageType, callback: (msg: WSMessage) => void) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set())
    }
    this.listeners.get(type)!.add(callback)
    return () => {
      this.listeners.get(type)?.delete(callback)
    }
  }

  private handleMessage(msg: WSMessage) {
    const callbacks = this.listeners.get(msg.type)
    if (callbacks) {
      callbacks.forEach((cb: (m: WSMessage) => void) => cb(msg))
    }
  }
  
  send(data: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }
}

// 全局实例（使用 config 中的 relay 列表 + fallback）
export const p2pWS = new P2PWebSocketClient(P2P_CONFIG.RELAY_WS_URLS)
