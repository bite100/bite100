/* 比特100 - Service Worker，支持安装到主屏与更新 */
const CACHE_NAME = 'bit100-sw-v2'
const STATIC_CACHE_NAME = 'bit100-static-v2'
const API_CACHE_NAME = 'bit100-api-v2'

// 预缓存的关键静态资源
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS.map(url => new Request(url, { cache: 'reload' })))
    }).then(() => {
      return self.skipWaiting() // 立即激活新版本
    })
  )
})

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
  if (event.data && event.data.type === 'CACHE_URLS') {
    // 允许客户端请求缓存特定URL
    event.waitUntil(
      caches.open(CACHE_NAME).then((cache) => {
        return cache.addAll(event.data.urls)
      })
    )
  }
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names
          .filter((name) => name !== CACHE_NAME && name !== STATIC_CACHE_NAME && name !== API_CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    }).then(() => self.clients.claim())
  )
})

// 缓存策略：网络优先，失败时使用缓存
async function networkFirst(request) {
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME)
      cache.put(request, response.clone())
    }
    return response
  } catch (error) {
    const cached = await caches.match(request)
    if (cached) {
      return cached
    }
    // 对于导航请求，返回离线页面
    if (request.mode === 'navigate') {
      return caches.match('/index.html') || new Response('离线模式', {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      })
    }
    throw error
  }
}

// 缓存策略：缓存优先，适合静态资源
async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) {
    return cached
  }
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE_NAME)
      cache.put(request, response.clone())
    }
    return response
  } catch (error) {
    return new Response('资源加载失败', { status: 503 })
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // 只处理 GET 请求
  if (request.method !== 'GET') return

  // 只处理同源请求
  if (url.origin !== self.location.origin) return

  // 静态资源：缓存优先
  if (
    url.pathname.match(/\.(js|css|ico|svg|png|jpg|jpeg|gif|woff2?|ttf|eot)$/) ||
    url.pathname === '/manifest.webmanifest'
  ) {
    event.respondWith(cacheFirst(request))
    return
  }

  // HTML 页面：网络优先，失败时使用缓存
  if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(networkFirst(request))
    return
  }

  // API 请求：网络优先，短期缓存
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      networkFirst(request).catch(async () => {
        const cached = await caches.match(request)
        if (cached) {
          // 检查缓存是否过期（5分钟）
          const cacheDate = cached.headers.get('sw-cache-date')
          if (cacheDate && Date.now() - parseInt(cacheDate) < 5 * 60 * 1000) {
            return cached
          }
        }
        return new Response(JSON.stringify({ error: '离线且无缓存' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        })
      })
    )
    return
  }

  // 其他资源：网络优先
  event.respondWith(networkFirst(request))
})
