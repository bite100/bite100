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
  request: (baseUrl: string) => Promise<T>,
  options?: { signal?: AbortSignal }
): Promise<{ data: T; baseUrl: string }> {
  const urls = getNodeUrls()
  if (urls.length === 0) throw new Error('节点服务暂不可用：行情与订单簿由节点提供，请稍后再试；你的链上资产与跨链功能不受影响')
  let lastErr: unknown
  for (const baseUrl of urls) {
    try {
      const data = await request(baseUrl)
      return { data, baseUrl }
    } catch (e) {
      lastErr = e
      // 第 40 轮（第 39 轮复审 F1）：调用方信号已取消 → 立即抛错短路，
      // 不再拿已取消的信号去试下一个节点；无信号时行为与此前一致。
      if (options?.signal?.aborted) throw e
    }
  }
  throw lastErr ?? new Error('所有节点均不可用')
}

/**
 * 使用当前节点列表发起 GET。
 * 第 39 轮：新增可选 options.signal（调用方超时/取消控制，如成交双源
 * 取数）；不传时与此前行为完全一致（无信号、逐节点尝试）。信号一旦
 * abort，tryNodes 在当次尝试失败后即短路抛错、不再试后续节点——整源
 * 立即判失败，符合超时语义（短路为第 40 轮补，此前靠已取消信号让后续
 * fetch 立即失败兜底，语义一致但多走空转）。
 */
export async function nodeGet<T>(
  path: string,
  params?: Record<string, string>,
  options?: { signal?: AbortSignal },
): Promise<{ data: T; baseUrl: string }> {
  return tryNodes(
    async (baseUrl) => {
      const url = new URL(path, baseUrl)
      if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
      const r = options?.signal
        ? await fetch(url.toString(), { signal: options.signal })
        : await fetch(url.toString())
      if (!r.ok) throw new Error(r.statusText || String(r.status))
      return r.json() as Promise<T>
    },
    { signal: options?.signal },
  )
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
    if (!r.ok) {
      // 把服务端响应体带进错误：市价单空盘口拒绝等业务原因写在 body 里，用户需要看到
      const detail = (await r.text().catch(() => '')).trim()
      throw new Error(detail || r.statusText || String(r.status))
    }
    return r.json() as Promise<{ ok: boolean }>
  })
}
