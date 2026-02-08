export type WSMessageType = 'orderbook_update' | 'trade' | 'order_status'

export interface WSMessage {
  type: WSMessageType
  pair?: string
  data: any
}

export class P2PWebSocketClient {
  private ws: WebSocket | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private listeners: Map<WSMessageType, Set<(data: any) => void>> = new Map()
  private url: string
  
  constructor(url: string) {
    this.url = url
  }
  
  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return
    
    console.log('连接 P2P 节点 WebSocket:', this.url)
    this.ws = new WebSocket(this.url)
    
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
    
    this.ws.onerror = (error) => {
      console.error('WebSocket 错误:', error)
    }
    
    this.ws.onclose = () => {
      console.log('WebSocket 断开，5 秒后重连...')
      this.reconnectTimer = setTimeout(() => this.connect(), 5000)
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

// 全局实例
export const p2pWS = new P2PWebSocketClient(
  import.meta.env.VITE_P2P_WS_URL || 'ws://localhost:8080/ws'
)
