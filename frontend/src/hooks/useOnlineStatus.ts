import { useState, useEffect } from 'react'

/**
 * 浏览器在线/离线状态 Hook
 * 封装 window.navigator.onLine + online/offline 事件，供 App、订单簿等复用
 */
export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState(() => (typeof navigator !== 'undefined' ? navigator.onLine : true))

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onOnline = () => setIsOnline(true)
    const onOffline = () => setIsOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  return isOnline
}

