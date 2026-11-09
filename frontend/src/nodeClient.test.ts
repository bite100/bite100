/**
 * nodeClient 单元测试：tryNodes 多节点回退、nodeGet/nodePost（mock config + fetch）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tryNodes, nodeGet, nodePost, NODE_POST_TIMEOUT_MS, isTimeoutError } from './nodeClient'

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
      // 第 46 轮：nodePost 每次尝试带请求超时信号（此前无超时）
      signal: expect.any(AbortSignal),
    })
  })

  it('第 46/48 轮：节点请求挂死时在共享截止期超时失败，不无限等，且分类为 TimeoutError', async () => {
    // AbortSignal.timeout 的内部计时不受 vitest 假计时器控制，故把
    // 真实超时压缩到 10ms 验证：第 48 轮起 NODE_POST_TIMEOUT_MS 是
    // 整轮共享截止期（只申请一次信号）——到点后不再试后续节点，
    // 抛出的错误命名 TimeoutError（isTimeoutError 可分类），区别于
    // 一般节点错误；第 46 轮的旧口径（逐节点各一份信号、最长
    // ~45s、抛原始 abort 错误）已被取代。
    const realTimeout = AbortSignal.timeout.bind(AbortSignal)
    const spy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms: number) => realTimeout(Math.min(ms, 10)))
    try {
      ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new Error('The operation was aborted')),
            )
          }),
      )
      const err = await nodePost('/api/order', {}).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).name).toBe('TimeoutError')
      expect(isTimeoutError(err)).toBe(true)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith(NODE_POST_TIMEOUT_MS)
      // 截止期到点即收尾：只打了第一个节点，不再空转后续节点
      expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('第 48 轮：共享截止期只申请一次信号——三节点全失败时也只调一次 AbortSignal.timeout', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    try {
      ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        text: () => Promise.resolve(''),
      })
      await expect(nodePost('/api/order', {})).rejects.toThrow()
      expect(globalThis.fetch).toHaveBeenCalledTimes(3)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith(NODE_POST_TIMEOUT_MS)
    } finally {
      spy.mockRestore()
    }
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

describe('isTimeoutError 超时错误分类（第 48 轮）', () => {
  it('TimeoutError / AbortError 命名错误归超时', () => {
    const t = new Error('timed out')
    t.name = 'TimeoutError'
    expect(isTimeoutError(t)).toBe(true)
    const a = new Error('aborted')
    a.name = 'AbortError'
    expect(isTimeoutError(a)).toBe(true)
  })

  it('消息含 timeout/timed out 的错误归超时', () => {
    expect(isTimeoutError(new Error('request timeout after 15000ms'))).toBe(true)
    expect(isTimeoutError(new Error('The operation timed out'))).toBe(true)
  })

  it('一般节点错误不归超时（含非 Error 值）', () => {
    expect(isTimeoutError(new Error('node down'))).toBe(false)
    expect(isTimeoutError(new Error('Bad Gateway'))).toBe(false)
    expect(isTimeoutError('timeout')).toBe(false)
    expect(isTimeoutError(null)).toBe(false)
  })
})

describe('tryNodes 共享截止期（第 48 轮）', () => {
  it('deadlineMs 内首节点成功 → 正常返回，信号透传给 request', async () => {
    let seenSignal: AbortSignal | undefined
    const res = await tryNodes(
      async (_baseUrl, signal) => {
        seenSignal = signal
        return { ok: true }
      },
      { deadlineMs: 60_000 },
    )
    expect(res.data).toEqual({ ok: true })
    expect(seenSignal).toBeInstanceOf(AbortSignal)
    expect(seenSignal!.aborted).toBe(false)
  })

  it('无 deadlineMs 时 request 收到的信号为 undefined（旧行为不变）', async () => {
    let seenSignal: AbortSignal | undefined = AbortSignal.timeout(60_000)
    await tryNodes(async (_baseUrl, signal) => {
      seenSignal = signal
      return 1
    })
    expect(seenSignal).toBeUndefined()
  })
})
