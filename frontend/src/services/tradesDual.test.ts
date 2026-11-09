/**
 * 成交读取测试：第 34–39 轮为「节点 + 索引」双源合并（mergeTradeSources /
 * loadDualTrades 的去重、冲突抑制、双源独立失败与双源超时均已随节点
 * 退役删除，登记见第 51 轮文档）；第 51 轮起只剩链上索引单源：
 * - fetchIndexerTrades 按交易对代币集合过滤（服务端 where + 客户端兜底）；
 * - GraphQL errors 非空判失败、超时真取消（signal 真传进 fetch）；
 * - loadIndexerTrades 单源口径：成功换算展示值，失败/未配置 → failed=true，
 *   绝不拿空数据冒充「暂无成交」。
 */
import { describe, it, expect } from 'vitest'
import {
  TRADES_QUERY,
  buildTradesQueryVariables,
  fetchIndexerTrades,
  indexerTradeToDisplay,
  loadIndexerTrades,
  type IndexerTrade,
} from './tradesDual'

const BASE = '0x1111111111111111111111111111111111111111'
const QUOTE = '0x2222222222222222222222222222222222222222'
const MAKER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const TAKER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const TX = `0x${'ab'.repeat(32)}`
const E18 = 10n ** 18n

// Sepolia BTC/USDT 的登记地址（config/chains.ts 第 25 轮 Mock 代币）
const BTC = '0x8EDa0025C245B10eA1E10c257674B794C85350f3'
const USDT = '0x6Ca8cb68Ee5BB15474f1cfFE07B895C974Ab9c6e'

function idx(over: Partial<IndexerTrade> = {}): IndexerTrade {
  return {
    id: `11155111-${TX}-5`,
    chainId: 11155111,
    txHash: TX,
    logIndex: 5,
    blockTimestamp: 1700001005,
    maker: MAKER,
    taker: TAKER,
    tokenIn: BASE,
    tokenOut: QUOTE,
    amountIn: (100n * E18).toString(),
    amountOut: (200n * E18).toString(),
    feeAmount: (1n * E18).toString(),
    makerDigest: '0xabc',
    takerDigest: '0xdef',
    ...over,
  }
}

describe('indexerTradeToDisplay（展示换算）', () => {
  it('卖出基础币（tokenIn=base）：数量=amountIn，价格=amountOut/amountIn，时间为链上区块时间', () => {
    const d = indexerTradeToDisplay(idx(), BASE)
    expect(d.price).toBeCloseTo(2)
    expect(d.amount).toBeCloseTo(100)
    expect(d.timestamp).toBe(1700001005)
    expect(d.key).toBe(`11155111-${TX}-5`)
    expect(d.logIndex).toBe(5)
  })

  it('买入基础币（tokenIn=quote）：数量=amountOut，价格=amountIn/amountOut', () => {
    const d = indexerTradeToDisplay(
      idx({
        tokenIn: QUOTE,
        tokenOut: BASE,
        amountIn: (200n * E18).toString(),
        amountOut: (100n * E18).toString(),
      }),
      BASE,
    )
    expect(d.price).toBeCloseTo(2)
    expect(d.amount).toBeCloseTo(100)
  })
})

describe('fetchIndexerTrades', () => {
  it('按交易对代币集合过滤掉其他代币组合', async () => {
    const rows = [
      { ...idx(), tokenIn: BTC, tokenOut: USDT },
      { ...idx(), id: 'other', tokenIn: '0x3333333333333333333333333333333333333333', tokenOut: USDT },
    ]
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { Trade: rows } }),
    })
    const out = await fetchIndexerTrades(11155111, 'BTC/USDT', 50, fetchFn, 'https://idx.example/graphql')
    expect(out.length).toBe(1)
    expect(out[0].tokenIn).toBe(BTC)
  })
})

describe('第 35 轮 D5：交易对过滤下沉到 GraphQL 服务端', () => {
  it('查询文本在 where 内按 tokenIn/tokenOut 双向组合过滤本对，并带 offset 分页', () => {
    expect(TRADES_QUERY).toContain('tokenIn: { _in: $base }')
    expect(TRADES_QUERY).toContain('tokenOut: { _in: $quote }')
    expect(TRADES_QUERY).toContain('tokenIn: { _in: $quote }')
    expect(TRADES_QUERY).toContain('tokenOut: { _in: $base }')
    expect(TRADES_QUERY).toContain('_or')
    expect(TRADES_QUERY).toContain('offset: $offset')
    expect(TRADES_QUERY).toContain('limit: $limit')
  })

  it('变量构造：地址带原样+小写双形态，limit/offset 透传', () => {
    const v = buildTradesQueryVariables(11155111, BTC, USDT, 50, 100)
    expect(v.chainId).toBe(11155111)
    expect(v.limit).toBe(50)
    expect(v.offset).toBe(100)
    expect(v.base).toEqual([BTC, BTC.toLowerCase()])
    expect(v.quote).toEqual([USDT, USDT.toLowerCase()])
  })

  it('fetchIndexerTrades 发出的请求体携带按对过滤变量与 offset', async () => {
    let body: { query: string; variables: Record<string, unknown> } | null = null
    const fetchFn = async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body)
      return { ok: true, status: 200, json: async () => ({ data: { Trade: [] } }) }
    }
    await fetchIndexerTrades(11155111, 'BTC/USDT', 25, fetchFn as never, 'https://idx.example/graphql', 50)
    expect(body!.query).toBe(TRADES_QUERY)
    expect(body!.variables).toMatchObject({ chainId: 11155111, limit: 25, offset: 50 })
    expect(body!.variables.base).toEqual([BTC, BTC.toLowerCase()])
    expect(body!.variables.quote).toEqual([USDT, USDT.toLowerCase()])
  })
})

describe('loadIndexerTrades（第 51 轮单源口径）', () => {
  const btcRow = { ...idx(), tokenIn: BTC, tokenOut: USDT }

  it('索引正常 → 展示行（价格/数量已换算），failed=false', async () => {
    const outcome = await loadIndexerTrades(11155111, 'BTC/USDT', 50, {
      endpoint: 'https://idx.example/graphql',
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: { Trade: [btcRow] } }),
      }),
    })
    expect(outcome.failed).toBe(false)
    expect(outcome.trades.length).toBe(1)
    expect(outcome.trades[0].price).toBeCloseTo(2)
    expect(outcome.trades[0].amount).toBeCloseTo(100)
    expect(outcome.trades[0].timestamp).toBe(1700001005)
    expect(outcome.trades[0].txHash).toBe(TX)
  })

  it('索引取数失败（HTTP 500）→ failed=true 且无数据（不冒充暂无成交）', async () => {
    const outcome = await loadIndexerTrades(11155111, 'BTC/USDT', 50, {
      endpoint: 'https://idx.example/graphql',
      fetchFn: async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
      }),
    })
    expect(outcome.failed).toBe(true)
    expect(outcome.trades).toEqual([])
  })

  it('索引未配置（endpoint 为空）→ failed=true', async () => {
    const outcome = await loadIndexerTrades(11155111, 'BTC/USDT', 50, { endpoint: '' })
    expect(outcome.failed).toBe(true)
    expect(outcome.trades).toEqual([])
  })

  it('交易对未登记 → failed=true', async () => {
    const outcome = await loadIndexerTrades(11155111, 'XXX/USDT', 50, {
      endpoint: 'https://idx.example/graphql',
    })
    expect(outcome.failed).toBe(true)
  })

  it('索引永不返回 → 超时后 failed=true（不无限等待），且底层 signal 已真 abort（第 39 轮纪律的单源形态）', async () => {
    let seenSignal: AbortSignal | undefined
    const outcome = await loadIndexerTrades(11155111, 'BTC/USDT', 50, {
      endpoint: 'https://idx.example/graphql',
      timeoutMs: 50,
      fetchFn: ((_url: string, init: { signal?: AbortSignal }) => {
        seenSignal = init.signal
        return new Promise(() => {})
      }) as never,
    })
    expect(outcome.failed).toBe(true)
    expect(outcome.trades).toEqual([])
    expect(seenSignal?.aborted).toBe(true)
  })
})

describe('第 39 轮：GraphQL errors 与超时真取消（fetchIndexerTrades 直调口径保留）', () => {
  it('HTTP 200 但带非空 errors → 抛错（判索引源失败）', async () => {
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ errors: [{ message: 'query execution failed' }] }),
    })
    await expect(
      fetchIndexerTrades(11155111, 'BTC/USDT', 50, fetchFn, 'https://idx.example/graphql'),
    ).rejects.toThrow('indexer graphql query failed')
  })

  it('errors 为空数组 → 不抛错，按 data 正常返回', async () => {
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ errors: [], data: { Trade: [] } }),
    })
    await expect(
      fetchIndexerTrades(11155111, 'BTC/USDT', 50, fetchFn, 'https://idx.example/graphql'),
    ).resolves.toEqual([])
  })

  it('AbortSignal 真传进 fetch init', async () => {
    let seen: AbortSignal | undefined
    const fetchFn = async (_url: string, init: { signal?: AbortSignal }) => {
      seen = init.signal
      return { ok: true, status: 200, json: async () => ({ data: { Trade: [] } }) }
    }
    await fetchIndexerTrades(11155111, 'BTC/USDT', 50, fetchFn as never, 'https://idx.example/graphql')
    expect(seen).toBeInstanceOf(AbortSignal)
    expect(seen!.aborted).toBe(false)
  })

  it('直接调用：内部超时到点 abort 底层请求并判失败（注入小值）', async () => {
    const fetchFn = ((_url: string, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as never
    await expect(
      fetchIndexerTrades(11155111, 'BTC/USDT', 50, fetchFn, 'https://idx.example/graphql', 0, {
        timeoutMs: 30,
      }),
    ).rejects.toThrow('aborted')
  })

  it('TRADES_QUERY 服务端排序带 logIndex 次级键', () => {
    expect(TRADES_QUERY).toContain('order_by: [{ blockTimestamp: desc }, { logIndex: desc }]')
  })
})
