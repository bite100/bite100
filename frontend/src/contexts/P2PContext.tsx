import React, { createContext, useContext, useEffect, useState } from 'react'
import { p2pManager } from '../p2p/manager'
import { OrderStorage } from '../p2p/storage'
import { Order } from '../p2p/types'

interface P2PContextType {
  isConnected: boolean
  peerId: string | null
  peerCount: number
  storageEnabled: boolean
  publishOrder: (order: Order) => Promise<void>
  cancelOrder: (orderId: string, signature: string) => Promise<void>
  getStats: () => any
}

const P2PContext = createContext<P2PContextType | null>(null)

interface P2PProviderProps {
  children: React.ReactNode
  enableStorage?: boolean // 是否启用 IndexedDB 持久化
}

export function P2PProvider({ children, enableStorage = false }: P2PProviderProps) {
  const [isConnected, setIsConnected] = useState(false)
  const [peerId, setPeerId] = useState<string | null>(null)
  const [peerCount, setPeerCount] = useState(0)
  const [storageEnabled, setStorageEnabled] = useState(false)

  useEffect(() => {
    // 启动 P2P 节点
    const startNode = async () => {
      try {
        await p2pManager.start(enableStorage)
        setIsConnected(true)
        setPeerId(p2pManager.getPeerId() || null)
        setStorageEnabled(p2pManager.isStorageEnabled())
        
        console.log('✅ P2P Context 已初始化')
        console.log('📊 持久化存储:', enableStorage ? '已启用' : '已禁用')
        
        // 定期更新 peer 数量
        const interval = setInterval(() => {
          setPeerCount(p2pManager.getPeerCount())
        }, 5000)
        
        return () => clearInterval(interval)
      } catch (error) {
        console.error('❌ 启动 P2P 节点失败:', error)
        setIsConnected(false)
      }
    }

    startNode()

    // 监听 peer 连接/断开事件
    const handlePeerConnect = () => {
      setPeerCount(p2pManager.getPeerCount())
    }

    const handlePeerDisconnect = () => {
      setPeerCount(p2pManager.getPeerCount())
    }

    window.addEventListener('p2p-peer-connect', handlePeerConnect)
    window.addEventListener('p2p-peer-disconnect', handlePeerDisconnect)

    // 清理
    return () => {
      window.removeEventListener('p2p-peer-connect', handlePeerConnect)
      window.removeEventListener('p2p-peer-disconnect', handlePeerDisconnect)
      p2pManager.stop()
    }
  }, [enableStorage])

  const publishOrder = async (order: Order) => {
    const publisher = p2pManager.getPublisher()
    if (!publisher) throw new Error('P2P 节点未启动')
    await publisher.publishOrder(order)
    if (p2pManager.isStorageEnabled()) {
      await OrderStorage.saveOrder(order)
    }
  }

  const cancelOrder = async (orderId: string, signature: string) => {
    const publisher = p2pManager.getPublisher()
    if (!publisher) throw new Error('P2P 节点未启动')
    await publisher.publishCancel({ orderId, signature })
  }

  const getStats = () => {
    return p2pManager.getStats()
  }

  return (
    <P2PContext.Provider
      value={{
        isConnected,
        peerId,
        peerCount,
        storageEnabled,
        publishOrder,
        cancelOrder,
        getStats,
      }}
    >
      {children}
    </P2PContext.Provider>
  )
}

export function useP2P() {
  const context = useContext(P2PContext)
  if (!context) {
    throw new Error('useP2P must be used within P2PProvider')
  }
  return context
}
