import { useEffect, useState } from 'react'
import { OrderStorage } from '../p2p/storage'
import type { StoredOrder } from '../p2p/storage'

/**
 * 从 IndexedDB 加载当前用户的订单（含 pending/partial/settled），并监听订单簿更新以刷新
 * App 启动时即可显示「我的订单」，关浏览器/Electron 重开后仍可恢复
 */
export function useMyOrders(trader: string | null): { orders: StoredOrder[]; loading: boolean; refresh: () => Promise<void> } {
  const [orders, setOrders] = useState<StoredOrder[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = async () => {
    if (!trader) {
      setOrders([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const list = await OrderStorage.getUserOrders(trader)
      setOrders(list)
    } catch (e) {
      console.error('useMyOrders refresh failed', e)
      setOrders([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [trader])

  useEffect(() => {
    const onUpdate = () => refresh()
    window.addEventListener('orderbook-update', onUpdate)
    window.addEventListener('trade-executed', onUpdate)
    window.addEventListener('trade-settled', onUpdate)
    return () => {
      window.removeEventListener('orderbook-update', onUpdate)
      window.removeEventListener('trade-executed', onUpdate)
      window.removeEventListener('trade-settled', onUpdate)
    }
  }, [trader])

  return { orders, loading, refresh }
}
