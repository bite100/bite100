/**
 * 第 34 轮成交双源合并测试：
 * - 精确匹配（同 tx + 双方 + 数量）→ both，展示以链上为准；
 * - 节点独有 → 待索引；Envio 独有 → 照常展示；
 * - 同 tx 同双方数量冲突 → 链上为准、节点行抑制并计数；
 * - 批量 tx 多笔同 tx 不同数量各自配对，不重不漏；
 * - GraphQL 拉取按交易对代币集合过滤。
 */
import { describe, it, expect } from 'vitest'
import {
  TRADES_QUERY,
  buildTradesQueryVariables,
  fetchIndexerTrades,
  loadDualTrades,
  mergeTradeSources,
  type IndexerTrade,
  type NodeTrade,
} from './tradesDual'

const BASE = '0x1111111111111111111111111111111111111111'
const QUOTE = '0x2222222222222222222222222222222222222222'
const MAKER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const TAKER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const TX = `0x${'ab'.repeat(32)}`
const E18 = 10n ** 18n

function node(over: Partial<NodeTrade> = {}): NodeTrade {
  return {
    tradeId: 'n1',
    txHash: TX,
    maker: MAKER,
    taker: TAKER,
    tokenIn: BASE,
    tokenOut: QUOTE,
    amountIn: (100n * E18).toString(),
    amountOut: (200n * E18).toString(),
    price: (2n * E18).toString(),
    amount: (100n * E18).toString(),
    timestamp: 1700001000,
    ...over,
  }
}

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

describe('mergeTradeSources', () => {
  it('精确匹配 → both，价格/数量/时间以链上事件为准', () => {
    const { trades, conflicts } = mergeTradeSources([node()], [idx()], BASE)
    expect(conflicts).toBe(0)
    expect(trades.length).toBe(1)
    expect(trades[0].source).toBe('both')
    expect(trades[0].pendingIndex).toBe(false)
    expect(trades[0].timestamp).toBe(1700001005) // 链上区块时间，而非节点时间
    expect(trades[0].price).toBeCloseTo(2)
    expect(trades[0].amount).toBeCloseTo(100)
    expect(trades[0].logIndex).toBe(5)
  })

  it('节点独有 → 待索引；Envio 独有 → 照常展示', () => {
    const only = idx({ id: 'x-9', txHash: `0x${'ff'.repeat(32)}`, logIndex: 9 })
    const { trades } = mergeTradeSources([node({ txHash: '' })], [only], BASE)
    expect(trades.length).toBe(2)
    const pending = trades.find((t) => t.source === 'node')!
    expect(pending.pendingIndex).toBe(true)
    expect(trades.find((t) => t.source === 'envio')!.pendingIndex).toBe(false)
  })

  it('同 tx 同双方但数量冲突 → 以链上为准，节点行被抑制', () => {
    const { trades, conflicts } = mergeTradeSources(
      [node({ amountIn: (90n * E18).toString() })],
      [idx()],
      BASE,
    )
    expect(conflicts).toBe(1)
    expect(trades.length).toBe(1)
    expect(trades[0].source).toBe('envio')
    expect(trades[0].amount).toBeCloseTo(100)
  })

  it('批量 tx 两笔：按数量多重集各自配对，不重不漏', () => {
    const tx2 = TX
    const n1 = node({ tradeId: 'b1', amountIn: (100n * E18).toString(), amountOut: (200n * E18).toString() })
    const n2 = node({ tradeId: 'b2', amountIn: (50n * E18).toString(), amountOut: (100n * E18).toString() })
    const i1 = idx({ id: `11155111-${tx2}-5`, logIndex: 5 })
    const i2 = idx({
      id: `11155111-${tx2}-6`,
      logIndex: 6,
      amountIn: (50n * E18).toString(),
      amountOut: (100n * E18).toString(),
    })
    const { trades, conflicts } = mergeTradeSources([n1, n2], [i2, i1], BASE)
    expect(conflicts).toBe(0)
    expect(trades.length).toBe(2)
    expect(trades.every((t) => t.source === 'both')).toBe(true)
    expect(new Set(trades.map((t) => t.logIndex))).toEqual(new Set([5, 6]))
  })

  it('未配置索引器（Envio 为空）→ 全部节点行待索引，行为等价单源', () => {
    const { trades } = mergeTradeSources([node()], [], BASE)
    expect(trades.length).toBe(1)
    expect(trades[0].source).toBe('node')
    expect(trades[0].pendingIndex).toBe(true)
  })
})

describe('fetchIndexerTrades', () => {
  it('按交易对代币集合过滤掉其他代币组合', async () => {
    // Sepolia BTC/USDT 的登记地址（config/chains.ts 第 25 轮 Mock 代币）
    const BTC = '0x8EDa0025C245B10eA1E10c257674B794C85350f3'
    const USDT = '0x6Ca8cb68Ee5BB15474f1cfFE07B895C974Ab9c6e'
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
  const BTC = '0x8EDa0025C245B10eA1E10c257674B794C85350f3'
  const USDT = '0x6Ca8cb68Ee5BB15474f1cfFE07B895C974Ab9c6e'

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

describe('第 35 轮 D6：loadDualTrades 两源独立失败', () => {
  const down = () => Promise.reject(new Error('source down'))

  it('节点宕机 → Envio 数据照常展示，nodeFailed 置位、unavailable 不置位', async () => {
    const outcome = await loadDualTrades(down, async () => [idx()], BASE)
    expect(outcome.nodeFailed).toBe(true)
    expect(outcome.indexerFailed).toBe(false)
    expect(outcome.unavailable).toBe(false)
    expect(outcome.result.trades.length).toBe(1)
    expect(outcome.result.trades[0].source).toBe('envio')
  })

  it('索引宕机 → 节点数据以「待索引」展示，indexerFailed 置位', async () => {
    const outcome = await loadDualTrades(async () => [node()], down, BASE)
    expect(outcome.nodeFailed).toBe(false)
    expect(outcome.indexerFailed).toBe(true)
    expect(outcome.unavailable).toBe(false)
    expect(outcome.result.trades.length).toBe(1)
    expect(outcome.result.trades[0].pendingIndex).toBe(true)
  })

  it('两源皆宕机 → 空结果 + unavailable（界面据此明示不可用）', async () => {
    const outcome = await loadDualTrades(down, down, BASE)
    expect(outcome.nodeFailed).toBe(true)
    expect(outcome.indexerFailed).toBe(true)
    expect(outcome.unavailable).toBe(true)
    expect(outcome.result.trades.length).toBe(0)
  })

  it('两源正常 → 合并 both，失败标记全清', async () => {
    const outcome = await loadDualTrades(async () => [node()], async () => [idx()], BASE)
    expect(outcome.nodeFailed).toBe(false)
    expect(outcome.indexerFailed).toBe(false)
    expect(outcome.unavailable).toBe(false)
    expect(outcome.result.trades[0].source).toBe('both')
  })
})
