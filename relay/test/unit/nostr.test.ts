import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools'
import {
  buildMirrorRecord,
  buildOrderEvent,
  nostrToolsPublish,
  parsePostmanSecret,
  publishToRelays,
  resolveRelayUrls,
} from '../../src/nostr'
import type { NodeOrderBody } from '../../src/orders'

const SECRET = generateSecretKey()
const SECRET_HEX = Array.from(SECRET)
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('')

const RECORD = {
  orderId: 'x',
  trader: '0x' + '12'.repeat(20),
  pair: 'BTC/USDT',
  side: 'sell',
  price: '100',
  amount: '5',
  filled: '0',
  status: 'open',
  nonce: 7,
  createdAt: 1700000000,
  expiresAt: 1999999999,
  signature: '0x' + 'cd'.repeat(65),
  chainId: 11155111,
  digest: '0x' + 'ab'.repeat(32),
}

const INPUT = {
  record: RECORD,
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
  it('事件可验签，标签含 d=digest / pair / chain / exp + NIP-40 expiration，content 为归一化记录 JSON', () => {
    const ev = buildOrderEvent(INPUT, SECRET, 30078, 1700000000)
    expect(ev.kind).toBe(30078)
    expect(ev.pubkey).toBe(getPublicKey(SECRET))
    expect(verifyEvent(ev)).toBe(true)
    expect(ev.tags).toEqual([
      ['d', INPUT.digest],
      ['pair', 'BTC/USDT'],
      ['chain', '11155111'],
      ['exp', '1999999999'],
      // 第 59 轮块 4（审计 ⑤）：NIP-40 标准过期标签与自有 exp 并存，
      // 支持 NIP-40 的中继到期自删；值必须与 exp 一致
      ['expiration', '1999999999'],
    ])
    expect(ev.content).toBe(JSON.stringify(RECORD))
    expect(ev.id).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('buildMirrorRecord（审查修复批 P2：镜像归一化）', () => {
  // 投毒提交：请求体自报 status='cancelled'、filled='999'（不在签名
  // 覆盖内）——镜像记录必须用服务端生成值，污染值无从进入。
  const poisonedBody: NodeOrderBody = {
    orderId: 'victim-order',
    trader: '0xABCDEF0000000000000000000000000000001234',
    pair: 'BTC/USDT',
    side: 'sell',
    price: '100',
    amount: '5',
    filled: '999',
    status: 'cancelled',
    nonce: 7,
    createdAt: 1700000000,
    expiresAt: 1999999999,
    signature: '0x' + 'cd'.repeat(65),
    execType: 'limit',
  }
  const digest = '0x' + 'ab'.repeat(32)

  it('自报 status/filled 被丢弃：记录恒 open/0，且带全部签名原字段+签名+digest+chainId', () => {
    const rec = buildMirrorRecord(poisonedBody, {
      digest,
      chainId: 11155111,
      expiresAt: 1999999999,
    })
    expect(rec.status).toBe('open')
    expect(rec.filled).toBe('0')
    expect(rec).toEqual({
      orderId: 'victim-order',
      trader: '0xabcdef0000000000000000000000000000001234', // 入库同口径小写化
      pair: 'BTC/USDT',
      side: 'sell',
      price: '100',
      amount: '5',
      filled: '0',
      status: 'open',
      nonce: 7,
      createdAt: 1700000000,
      expiresAt: 1999999999,
      signature: '0x' + 'cd'.repeat(65),
      chainId: 11155111,
      digest,
      execType: 'limit',
    })
  })

  it('投毒提交产出的镜像事件 content 解析后 status=open、filled=0（不含请求原文的污染值）', () => {
    const rec = buildMirrorRecord(poisonedBody, {
      digest,
      chainId: 11155111,
      expiresAt: 1999999999,
    })
    const ev = buildOrderEvent(
      { record: rec, digest, pair: 'BTC/USDT', chainId: 11155111, expiresAt: 1999999999 },
      SECRET,
      30078,
      1700000000,
    )
    const parsed = JSON.parse(ev.content) as Record<string, unknown>
    expect(parsed.status).toBe('open')
    expect(parsed.filled).toBe('0')
    expect(ev.content).not.toContain('cancelled')
    expect(ev.content).not.toContain('"999"')
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
