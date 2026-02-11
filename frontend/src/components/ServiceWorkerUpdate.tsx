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
            setShow(true)
          }
        })
      })
      /* 页面可见时检查更新（如从其他标签切回） */
      const checkUpdate = () => reg.update().catch(() => {})
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkUpdate() })
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
      registration.waiting?.postMessage({ type: 'SKIP_WAITING' })
    })
  }

  if (!show) return null

  return (
    <div className="sw-update-banner" role="alert">
      <span className="sw-update-text">新版本已就绪</span>
      <button type="button" className="sw-update-btn" onClick={handleRefresh}>
        刷新
      </button>
    </div>
  )
}
