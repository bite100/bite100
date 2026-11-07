import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools'
import {
  buildOrderEvent,
  nostrToolsPublish,
  parsePostmanSecret,
  publishToRelays,
  resolveRelayUrls,
} from '../../src/nostr'

const SECRET = generateSecretKey()
const SECRET_HEX = Array.from(SECRET)
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('')

const INPUT = {
  rawJson: '{"orderId":"x","pair":"BTC/USDT"}',
  digest: '0x' + 'ab'.repeat(32),
  pair: 'BTC/USDT',
  chainId: 11155111,
  expiresAt: 1999999999,
}

describe('parsePostmanSecret', () => {
  it('hex 与 nsec 两种形式都可解析，垃圾值返回 null', () => {
    expect(parsePostmanSecret(SECRET_HEX)).toEqual(SECRET)
    expect(parsePostmanSecret(nip19.nsecEncode(SECRET))).toEqual(SECRET)
    expect(parsePostmanSecret('not-a-key')).toBeNull()
    expect(parsePostmanSecret(undefined)).toBeNull()
    expect(parsePostmanSecret('')).toBeNull()
  })
})

describe('buildOrderEvent', () => {
  it('事件可验签，标签含 d=digest / pair / chain / exp，content 为订单 JSON', () => {
    const ev = buildOrderEvent(INPUT, SECRET, 30078, 1700000000)
    expect(ev.kind).toBe(30078)
    expect(ev.pubkey).toBe(getPublicKey(SECRET))
    expect(verifyEvent(ev)).toBe(true)
    expect(ev.tags).toEqual([
      ['d', INPUT.digest],
      ['pair', 'BTC/USDT'],
      ['chain', '11155111'],
      ['exp', '1999999999'],
    ])
    expect(ev.content).toBe(INPUT.rawJson)
    expect(ev.id).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('publishToRelays（注入 mock 发布函数）', () => {
  const ev = buildOrderEvent(INPUT, SECRET)

  it('第一个中继失败自动试第二个，成功返回其 event id 与中继名', async () => {
    const tried: string[] = []
    const res = await publishToRelays(ev, ['wss://a', 'wss://b'], {
      publish: async (url) => {
        tried.push(url)
        if (url === 'wss://a') throw new Error('down')
      },
    })
    expect(tried).toEqual(['wss://a', 'wss://b'])
    expect(res).toEqual({ eventId: ev.id, relay: 'wss://b' })
  })

  it('全部失败返回 null 且不抛错（best-effort）', async () => {
    const res = await publishToRelays(ev, ['wss://a'], {
      publish: async () => {
        throw new Error('down')
      },
    })
    expect(res).toBeNull()
  })
})

describe('publishToRelays（真实 nostr-tools 对本地 mock 中继）', () => {
  let wss: WebSocketServer
  let url: string
  const received: unknown[] = []

  beforeAll(async () => {
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => wss.on('listening', resolve))
    const port = (wss.address() as { port: number }).port
    url = `ws://127.0.0.1:${port}`
    wss.on('connection', (ws: WebSocket) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as unknown[]
        if (msg[0] === 'EVENT') {
          received.push(msg[1])
          const ev = msg[1] as { id: string }
          ws.send(JSON.stringify(['OK', ev.id, true, '']))
        }
      })
    })
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  })

  it('经 nostrToolsPublish 真发成功，mock 中继收到同一事件', async () => {
    const ev = buildOrderEvent(INPUT, SECRET)
    const res = await publishToRelays(ev, [url], {
      publish: nostrToolsPublish,
      timeoutMs: 8000,
    })
    expect(res).toEqual({ eventId: ev.id, relay: url })
    expect(received).toHaveLength(1)
    expect((received[0] as { id: string }).id).toBe(ev.id)
  })
})

describe('resolveRelayUrls', () => {
  it('空值回默认列表；非法项被过滤', () => {
    expect(resolveRelayUrls(undefined).length).toBeGreaterThanOrEqual(2)
    expect(resolveRelayUrls('wss://a, http://bad, ws://b')).toEqual(['wss://a', 'ws://b'])
  })
})
