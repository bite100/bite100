import { P2P_CONFIG } from '../config'

export type WSMessageType = 'orderbook_update' | 'trade' | 'order_status'

export interface WSMessage {
  type: WSMessageType
  pair?: string
  data: any
}

/** 多 relay fallback：按 RELAY_WS_URLS 列表依次尝试，断线后尝试下一个再重试 */
export class P2PWebSocketClient {
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private listeners: Map<WSMessageType, Set<(data: any) => void>> = new Map()
  private urls: string[]
  private currentIndex = 0

  constructor(urls?: string[]) {
    this.urls = urls?.length ? urls : [P2P_CONFIG.WS_URL]
  }

  private get currentUrl(): string {
    return this.urls[this.currentIndex % this.urls.length]
  }

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return

    const url = this.currentUrl
    console.log('连接 P2P Relay WebSocket:', url, `(${this.currentIndex + 1}/${this.urls.length})`)
    this.ws = new WebSocket(url)

    this.ws.onopen = () => {
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
      // 错误时 onclose 会触发，在 onclose 里做 fallback
    }

    this.ws.onclose = () => {
      this.ws = null
      if (this.urls.length > 1) {
        this.currentIndex++
        console.log('WebSocket 断开，尝试下一个 relay...')
        this.reconnectTimer = setTimeout(() => this.connect(), 1500)
      } else {
        console.log('WebSocket 断开，5 秒后重连...')
        this.reconnectTimer = setTimeout(() => this.connect(), 5000)
      }
    }
  }
  
  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }
  
  subscribe(type: WSMessageType, callback: (data: any) => void) {
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
      callbacks.forEach(cb => cb(msg.data))
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
