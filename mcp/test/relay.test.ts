import { describe, expect, it } from 'vitest'
import { RelayClient } from '../src/relay'
import { ToolError } from '../src/errors'
import { jsonResponse, sampleOrder } from './helpers'

describe('RelayClient（mock fetch）', () => {
  it('listOrders 解析裸数组并带查询参数', async () => {
    let seenUrl = ''
    const client = new RelayClient('https://relay.invalid/', async (url: string) => {
      seenUrl = url
      return jsonResponse([sampleOrder])
    })
    const orders = await client.listOrders({ chainId: 11155111, pair: 'TKA/TKB', limit: 10 })
    expect(orders).toHaveLength(1)
    expect(orders[0].orderId).toBe('ord-1')
    expect(seenUrl).toContain('chain=11155111')
    expect(seenUrl).toContain('pair=TKA%2FTKB')
    expect(seenUrl).toContain('limit=10')
  })

  it('orderbook 透传 bids/asks', async () => {
    const client = new RelayClient('https://relay.invalid', async () =>
      jsonResponse({ pair: 'TKA/TKB', bids: [sampleOrder], asks: [] }),
    )
    const book = await client.orderbook({ chainId: 84532, pair: 'TKA/TKB' })
    expect(book.bids).toHaveLength(1)
    expect(book.asks).toHaveLength(0)
  })

  it('HTTP 非 200 → 结构化 relay_error', async () => {
    const client = new RelayClient('https://relay.invalid', async () =>
      jsonResponse({ error: 'bad' }, 500),
    )
    await expect(client.listOrders({ chainId: 11155111 })).rejects.toMatchObject({
      code: 'relay_error',
    })
  })

  it('网络失败 → relay_unreachable', async () => {
    const client = new RelayClient('https://relay.invalid', async () => {
      throw new Error('socket hangup')
    })
    await expect(client.health()).rejects.toBeInstanceOf(ToolError)
    await expect(client.health()).rejects.toMatchObject({ code: 'relay_unreachable' })
  })

  it('postOrder 返回状态与原文（拒单不抛，由调用方判定）', async () => {
    const client = new RelayClient('https://relay.invalid', async () =>
      jsonResponse({ error: 'invalid signature' }, 400),
    )
    const res = await client.postOrder({ any: 'thing' })
    expect(res.status).toBe(400)
    expect(res.text).toContain('invalid signature')
  })
})
