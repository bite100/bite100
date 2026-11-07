/**
 * Service Worker 更新提示：检测到新版本时展示横幅，用户点击后刷新
 */
import { useState, useEffect } from 'react'
import './ServiceWorkerUpdate.css'

export function ServiceWorkerUpdate() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') return /* PWA 需 HTTPS */

    let registration: ServiceWorkerRegistration | null = null

    const checkForUpdate = () => {
      // 检查是否在24小时内已忽略
      try {
        const dismissed = localStorage.getItem('sw-update-dismissed')
        if (dismissed && Date.now() - parseInt(dismissed) < 24 * 60 * 60 * 1000) {
          return
        }
      } catch {}
      
      if (registration?.waiting) {
        setShow(true)
      }
    }

    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => {
      registration = reg
      checkForUpdate()
      
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing
        if (!newWorker) return
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            checkForUpdate()
          }
        })
      })
      
      /* 页面可见时检查更新（如从其他标签切回） */
      const checkUpdate = () => {
        if (document.visibilityState === 'visible') {
          reg.update().catch(() => {})
        }
      }
      document.addEventListener('visibilitychange', checkUpdate)
      
      // 定期检查更新（每小时）
      setInterval(checkUpdate, 60 * 60 * 1000)
    }).catch(() => {})

    const onControllerChange = () => {
      window.location.reload()
    }
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
    }
  }, [])

  const handleRefresh = () => {
    navigator.serviceWorker?.ready.then((registration) => {
      if (registration.waiting) {
        registration.waiting.postMessage({ type: 'SKIP_WAITING' })
      } else {
        // 如果没有等待中的 worker，直接刷新
        window.location.reload()
      }
    }).catch(() => {
      // 如果出错，直接刷新
      window.location.reload()
    })
  }

  const handleDismiss = () => {
    setShow(false)
    // 24小时内不再显示
    try {
      localStorage.setItem('sw-update-dismissed', Date.now().toString())
    } catch {}
  }

  if (!show) return null

  return (
    <div className="sw-update-banner" role="alert">
      <span className="sw-update-text">新版本已就绪，刷新页面即可更新</span>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="button" className="sw-update-btn secondary" onClick={handleDismiss}>
          稍后
        </button>
        <button type="button" className="sw-update-btn" onClick={handleRefresh}>
          刷新
        </button>
      </div>
    </div>
  )
}
