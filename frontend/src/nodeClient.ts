/**
 * P2P 多节点连接：支持配置多个节点 API URL，请求时依次尝试直至成功
 * 适合手机端/弱网：一个节点不可用时自动切换
 */
import { NODE_API_URLS } from './config'

/** 解析得到的节点 URL 列表（与 config 中 NODE_API_URLS 逻辑一致，含单 URL 兜底） */
function getNodeUrls(): string[] {
  if (NODE_API_URLS.length > 0) return NODE_API_URLS
  const single = (import.meta.env.VITE_NODE_API_URL ?? '').trim().split(',')[0]?.trim().replace(/\/$/, '')
  return single ? [single] : []
}

/** 对多个节点依次尝试同一请求，返回第一个成功结果 */
export async function tryNodes<T>(
  request: (baseUrl: string) => Promise<T>
): Promise<{ data: T; baseUrl: string }> {
  const urls = getNodeUrls()
  if (urls.length === 0) throw new Error('未配置节点 API（VITE_NODE_API_URL）')
  let lastErr: unknown
  for (const baseUrl of urls) {
    try {
      const data = await request(baseUrl)
      return { data, baseUrl }
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error('所有节点均不可用')
}

/** 使用当前节点列表发起 GET */
export async function nodeGet<T>(path: string, params?: Record<string, string>): Promise<{ data: T; baseUrl: string }> {
  return tryNodes(async (baseUrl) => {
    const url = new URL(path, baseUrl)
    if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
    const r = await fetch(url.toString())
    if (!r.ok) throw new Error(r.statusText || String(r.status))
    return r.json() as Promise<T>
  })
}

/** 使用当前节点列表发起 POST（向第一个成功节点发送） */
export async function nodePost(
  path: string,
  body: unknown
): Promise<{ data: { ok: boolean }; baseUrl: string }> {
  return tryNodes(async (baseUrl) => {
    const r = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(r.statusText || String(r.status))
    return r.json() as Promise<{ ok: boolean }>
  })
}
