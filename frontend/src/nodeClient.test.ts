/**
 * nodeClient 单元测试：tryNodes 多节点回退、nodeGet/nodePost（mock config + fetch）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tryNodes, nodeGet, nodePost } from './nodeClient'

vi.mock('./config', () => ({
  NODE_API_URLS: ['http://node1', 'http://node2', 'http://node3'],
}))

describe('tryNodes', () => {
  it('returns first successful result and baseUrl', async () => {
    const data = { orderId: 'abc' }
    const res = await tryNodes(async (baseUrl: string) => {
      expect(baseUrl).toBe('http://node1')
      return data
    })
    expect(res).toEqual({ data, baseUrl: 'http://node1' })
  })

  it('tries next node when first fails', async () => {
    const data = { ok: true }
    const calls: string[] = []
    const res = await tryNodes(async (baseUrl) => {
      calls.push(baseUrl)
      if (baseUrl === 'http://node3') return data
      throw new Error('down')
    })
    expect(calls).toEqual(['http://node1', 'http://node2', 'http://node3'])
    expect(res).toEqual({ data, baseUrl: 'http://node3' })
  })

  it('throws last error when all nodes fail', async () => {
    const lastError = new Error('node3 failed')
    await expect(
      tryNodes(async (baseUrl) => {
        if (baseUrl === 'http://node3') throw lastError
        throw new Error('down')
      })
    ).rejects.toBe(lastError)
  })
})

describe('nodeGet', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn()
  })

  it('calls fetch with URL from first successful node and returns json', async () => {
    const payload = { pairs: ['TKA/TKB'] }
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(payload),
    })
    const res = await nodeGet('/api/pairs')
    expect(res.data).toEqual(payload)
    expect(res.baseUrl).toBe('http://node1')
    expect(globalThis.fetch).toHaveBeenCalledWith('http://node1/api/pairs')
  })

  it('retries next node when fetch returns !ok', async () => {
    const payload = { pairs: [] }
    ;(globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: false, statusText: 'Bad Gateway' })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(payload),
      })
    const res = await nodeGet('/api/pairs')
    expect(res.data).toEqual(payload)
    expect(res.baseUrl).toBe('http://node2')
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  it('appends query params when params given', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    })
    await nodeGet('/api/orders', { pair: 'TKA/TKB', limit: '10' })
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://node1/api/orders?pair=TKA%2FTKB&limit=10'
    )
  })
})

describe('tryNodes abort 短路（第 40 轮，第 39 轮复审 F1）', () => {
  it('signal 已 abort 且首次尝试失败 → 只调用一次请求函数并抛错', async () => {
    const controller = new AbortController()
    controller.abort()
    const abortErr = new Error('aborted')
    const calls: string[] = []
    await expect(
      tryNodes(
        async (baseUrl) => {
          calls.push(baseUrl)
          throw abortErr
        },
        { signal: controller.signal },
      ),
    ).rejects.toBe(abortErr)
    expect(calls).toEqual(['http://node1'])
  })

  it('signal 尝试途中被取消 → 在当次失败后短路，不试下一节点', async () => {
    const controller = new AbortController()
    const calls: string[] = []
    await expect(
      tryNodes(
        async (baseUrl) => {
          calls.push(baseUrl)
          controller.abort()
          throw new Error('aborted')
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow('aborted')
    expect(calls).toEqual(['http://node1'])
  })

  it('signal 未取消时失败仍回退下一节点（短路不误伤正常回退）', async () => {
    const controller = new AbortController()
    const data = { ok: true }
    const calls: string[] = []
    const res = await tryNodes(
      async (baseUrl) => {
        calls.push(baseUrl)
        if (baseUrl === 'http://node2') return data
        throw new Error('down')
      },
      { signal: controller.signal },
    )
    expect(calls).toEqual(['http://node1', 'http://node2'])
    expect(res).toEqual({ data, baseUrl: 'http://node2' })
  })
})

describe('nodeGet signal 透传（第 40 轮）', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn()
  })

  it('signal 已 abort 且 fetch 拒绝 → 只发一次请求，不再试下一节点', async () => {
    const controller = new AbortController()
    controller.abort()
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('aborted'),
    )
    await expect(
      nodeGet('/api/pairs', undefined, { signal: controller.signal }),
    ).rejects.toThrow('aborted')
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(globalThis.fetch).toHaveBeenCalledWith('http://node1/api/pairs', {
      signal: controller.signal,
    })
  })
})

describe('nodePost', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn()
  })

  it('sends POST with JSON body to first successful node', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    })
    const body = { pair: 'TKA/TKB', side: 'buy', amount: '100' }
    const res = await nodePost('/api/order', body)
    expect(res.data.ok).toBe(true)
    expect(res.baseUrl).toBe('http://node1')
    expect(globalThis.fetch).toHaveBeenCalledWith('http://node1/api/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  })

  it('throws when response is !ok', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
    })
    await expect(nodePost('/api/order', {})).rejects.toThrow()
  })
})
