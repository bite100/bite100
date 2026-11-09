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

/**
 * 超时错误分类（第 48 轮）：AbortSignal.timeout 的 TimeoutError、
 * 主动取消的 AbortError、本模块共享截止期抛出的同名错误、以及
 * 消息含 timeout/timed out 的错误归「超时」；其余为一般错误。
 * 调用方据此区分呈现（超时 = 结果待确认，一般错误 = 明确失败）。
 */
export function isTimeoutError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true
  return /timed?\s*out|timeout/i.test(e.message)
}

/**
 * 对多个节点依次尝试同一请求，返回第一个成功结果。
 *
 * 第 48 轮：共享截止期（第 46 轮复审登记的 UNKNOWN 修复）——
 * options.deadlineMs 给定时，整轮 tryNodes 只申请一次
 * AbortSignal.timeout，合成信号作为 request 的第二参贯穿所有
 * 节点（此前 nodePost 在每个节点各申请一份新的 15s 信号，三个
 * 节点最长拖到 ~45s，界面早已按 20s 期限返回、后台还在空转）。
 * 截止期到点后不再尝试后续节点，直接抛 TimeoutError 命名错误
 * （isTimeoutError 可分类）；调用方 signal 的短路语义（第 40 轮
 * F1）保持不变。
 */
export async function tryNodes<T>(
  request: (baseUrl: string, signal?: AbortSignal) => Promise<T>,
  options?: { signal?: AbortSignal; deadlineMs?: number }
): Promise<{ data: T; baseUrl: string }> {
  const urls = getNodeUrls()
  if (urls.length === 0) throw new Error('节点服务暂不可用：行情与订单簿由节点提供，请稍后再试；你的链上资产与跨链功能不受影响')
  const deadlineSignal =
    options?.deadlineMs && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(options.deadlineMs)
      : undefined
  const parts = [options?.signal, deadlineSignal].filter(
    (s): s is AbortSignal => Boolean(s),
  )
  const combined =
    parts.length === 0
      ? undefined
      : parts.length === 1
        ? parts[0]
        : typeof AbortSignal.any === 'function'
          ? AbortSignal.any(parts)
          : deadlineSignal
  let lastErr: unknown
  for (const baseUrl of urls) {
    try {
      const data = await request(baseUrl, combined)
      return { data, baseUrl }
    } catch (e) {
      lastErr = e
      // 共享截止期已到：分类为超时并立即收尾，不再试后续节点
      if (deadlineSignal?.aborted) {
        const err = new Error(
          `节点请求在共享截止期 ${options!.deadlineMs}ms 内未完成（超时，结果待确认）`
        )
        err.name = 'TimeoutError'
        throw err
      }
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
  options?: { signal?: AbortSignal; deadlineMs?: number },
): Promise<{ data: T; baseUrl: string }> {
  return tryNodes(
    async (baseUrl, signal) => {
      const url = new URL(path, baseUrl)
      if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
      const effective = signal ?? options?.signal
      const r = effective
        ? await fetch(url.toString(), { signal: effective })
        : await fetch(url.toString())
      if (!r.ok) throw new Error(r.statusText || String(r.status))
      return r.json() as Promise<T>
    },
    { signal: options?.signal, deadlineMs: options?.deadlineMs },
  )
}

/**
 * nodePost 超时（第 46 轮 P2-3 引入；第 48 轮改共享截止期）：此前
 * POST 无任何超时，节点连接挂死会把下单/撤单无限拖住。第 46 轮
 * 给逐节点尝试各一份 15s 信号（AbortSignal.timeout，与
 * relayDualSend 同模式），但三个节点最长累计 ~45s、无总截止。
 * 第 48 轮起 NODE_POST_TIMEOUT_MS 是整轮 tryNodes 的共享截止期
 * （只申请一次信号、贯穿所有节点）：到点抛 TimeoutError 命名
 * 错误并收尾，不再有界面返回后后台继续空转的窗口。
 * 注意：超时只说明「等不到回执」，不等于节点没收到——下单广播层
 * 对此有 UNKNOWN 口径（orderService 的 nodeUnknown），调用方不得
 * 把 nodePost 超时直接断言为「未接单」。
 */
export const NODE_POST_TIMEOUT_MS = 15_000

/** 使用当前节点列表发起 POST（向第一个成功节点发送） */
export async function nodePost(
  path: string,
  body: unknown
): Promise<{ data: { ok: boolean }; baseUrl: string }> {
  return tryNodes(
    async (baseUrl, signal) => {
      const r = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
      if (!r.ok) {
        // 把服务端响应体带进错误：市价单空盘口拒绝等业务原因写在 body 里，用户需要看到
        const detail = (await r.text().catch(() => '')).trim()
        throw new Error(detail || r.statusText || String(r.status))
      }
      return r.json() as Promise<{ ok: boolean }>
    },
    { deadlineMs: NODE_POST_TIMEOUT_MS },
  )
}
