/**
 * 中继 REST 转调层（骑现有中继接口，不改中继）：
 *   GET /health、GET /orders、GET /orderbook、POST /orders
 * 中继没有其他路由（无撤单路由——见 round49 文档的撤单面结论）。
 * fetch 可注入，便于单元测试 mock；默认 15s 超时。
 */
import { ToolError } from './errors'

export interface RelayOrder {
  orderId: string
  trader: string
  pair: string
  side: string
  price: string
  amount: string
  filled: string
  status: string
  nonce: number
  createdAt: number
  expiresAt: number
  signature: string
  chainId: number
  digest: string
  execType?: string
  [key: string]: unknown
}

export interface RelayBook {
  bids: RelayOrder[]
  asks: RelayOrder[]
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export class RelayClient {
  private base: string
  private fetchFn: FetchFn

  constructor(baseUrl: string, fetchFn: FetchFn = fetch) {
    this.base = baseUrl.replace(/\/+$/, '')
    this.fetchFn = fetchFn
  }

  private async getJson<T>(path: string): Promise<T> {
    let res: Response
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        signal: AbortSignal.timeout(15_000),
      })
    } catch (e) {
      throw new ToolError('relay_unreachable', `中继请求失败 ${path}: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!res.ok) {
      throw new ToolError('relay_error', `中继 ${path} 返回 HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
    }
    return (await res.json()) as T
  }

  health(): Promise<{ ok: boolean; db: string; time: number }> {
    return this.getJson('/health')
  }

  async listOrders(params: {
    chainId: number
    pair?: string
    userAddress?: string
    limit?: number
  }): Promise<RelayOrder[]> {
    const q = new URLSearchParams({ chain: String(params.chainId) })
    if (params.pair) q.set('pair', params.pair)
    if (params.userAddress) q.set('userAddress', params.userAddress)
    if (params.limit) q.set('limit', String(params.limit))
    const data = await this.getJson<{ orders?: RelayOrder[] } | RelayOrder[]>(`/orders?${q}`)
    return Array.isArray(data) ? data : (data.orders ?? [])
  }

  orderbook(params: { chainId: number; pair: string }): Promise<RelayBook> {
    const q = new URLSearchParams({ chain: String(params.chainId), pair: params.pair })
    return this.getJson<RelayBook>(`/orderbook?${q}`)
  }

  /** 投单：body 是节点/中继同一份订单原文（另加 chainId）；返回 HTTP 状态与原文 */
  async postOrder(body: Record<string, unknown>): Promise<{ status: number; text: string }> {
    let res: Response
    try {
      res = await this.fetchFn(`${this.base}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (e) {
      throw new ToolError('relay_unreachable', `中继投单失败: ${e instanceof Error ? e.message : String(e)}`)
    }
    return { status: res.status, text: (await res.text()).slice(0, 300) }
  }
}
