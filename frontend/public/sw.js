/* P2P 交易所 - 最小 Service Worker，支持安装到主屏与更新 */
const CACHE_NAME = 'p2p-exchange-v1'

self.addEventListener('install', (event) => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      )
    }).then(() => self.clients.claim())
  )
})

/* 网络优先，失败时对同源静态资源使用缓存 */
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate' && event.request.method !== 'GET') return
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const contentType = response.headers.get('content-type') || ''
        const cacheable = response.ok && (
          contentType.includes('text/html') ||
          contentType.includes('application/javascript') ||
          contentType.includes('text/css') ||
          url.pathname.match(/\.(js|css|ico|svg|woff2?)$/)
        )
        if (cacheable) {
          const clone = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
        }
        return response
      })
      .catch(() => caches.match(event.request).then((cached) => cached || new Response('', { status: 503, statusText: 'Offline' })))
  )
})
