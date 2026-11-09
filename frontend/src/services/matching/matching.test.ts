/**
 * 阶段 3 块 C 单元测试：撮合规则移植（与节点 engine.go 口径对向量）、
 * 剩余量换算、Fill 组装、预检剔腿与档位上限。全部纯逻辑/mock，不连网。
 */
import { describe, it, expect } from 'vitest'
import { matchTaker, deriveQuoteAmount, type MatcherOrder } from './matcher'
import { makerRemainingToken0 } from './fromEvaluated'
import { simulateAndPrune, capLegs, MAX_BATCH_LEGS } from './prune'
import { buildLegFill } from './fills'
import { executeFrontendMatch, type FrontendMatchRequest } from './execute'
import type { BookAdapter } from '../dualread/adapters'
import type { ChainStateReader } from '../dualread/chainState'
import type { EvaluatedOrder } from '../dualread/types'
import type { OrderData } from '../orderSigningTypes'
import { getPairTokens } from '../../config/pairs'

const E18 = 10n ** 18n
const A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const T = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'

function maker(over: Partial<MatcherOrder>): MatcherOrder {
  return {
    orderId: 'm1',
    trader: B,
    side: 'sell',
    priceWei: 2n * E18,
    remainingToken0: 100n * E18,
    timestamp: 1700000000,
    ...over,
  }
}

describe('matcher（节点规则移植）', () => {
  it('价格-时间优先：卖盘低价先、同价先到先；成交价=maker 价（价格改善归 taker）', () => {
    const res = matchTaker(
      { trader: T, side: 'buy', priceWei: 3n * E18, amountToken0: 120n * E18 },
      [
        maker({ orderId: 'hi', priceWei: 25n * (E18 / 10n), remainingToken0: 50n * E18, timestamp: 100 }),
        maker({ orderId: 'lo-late', priceWei: 2n * E18, remainingToken0: 50n * E18, timestamp: 200 }),
        maker({ orderId: 'lo-early', priceWei: 2n * E18, remainingToken0: 50n * E18, timestamp: 100 }),
      ],
    )
    expect(res.legs.map((l) => l.makerOrderId)).toEqual(['lo-early', 'lo-late', 'hi'])
    expect(res.legs[0].priceWei).toBe(2n * E18) // maker 价，不是 taker 的 3.0
    expect(res.filledToken0).toBe(120n * E18)
    expect(res.remainderToken0).toBe(0n)
  })

  it('限价不触价即停：买单限价低于最优卖价 → 无腿', () => {
    const res = matchTaker(
      { trader: T, side: 'buy', priceWei: 19n * (E18 / 10n), amountToken0: 10n * E18 },
      [maker({})],
    )
    expect(res.legs).toEqual([])
    expect(res.remainderToken0).toBe(10n * E18)
  })

  it('卖单吃买盘：高价先、成交量取 min、quote=qty×价/1e18 整数截断', () => {
    const res = matchTaker(
      { trader: T, side: 'sell', priceWei: 1n * E18, amountToken0: 30n * E18 },
      [
        maker({ orderId: 'b1', side: 'buy', priceWei: 21n * (E18 / 10n), remainingToken0: 10n * E18 }),
        maker({ orderId: 'b2', side: 'buy', priceWei: 2n * E18, remainingToken0: 50n * E18 }),
      ],
    )
    expect(res.legs.map((l) => l.makerOrderId)).toEqual(['b1', 'b2'])
    expect(res.legs[0].qtyToken0).toBe(10n * E18)
    expect(res.legs[0].quoteAmount).toBe(21n * E18)
    expect(res.legs[1].qtyToken0).toBe(20n * E18)
    expect(res.legs[1].quoteAmount).toBe(40n * E18)
    // 整数公式（含截断）：1 wei × 1.5e18 / 1e18 = 1 wei
    expect(deriveQuoteAmount(1n, 15n * (E18 / 10n))).toBe(1n)
    expect(deriveQuoteAmount(3n, 15n * (E18 / 10n))).toBe(4n)
  })

  it('市价（保护价）语义：保护价即 taker 价，越过保护价的档位不吃、余量返回（IOC）', () => {
    const res = matchTaker(
      { trader: T, side: 'buy', priceWei: 21n * (E18 / 10n), amountToken0: 500n * E18 },
      [
        maker({ orderId: 'in', priceWei: 2n * E18, remainingToken0: 40n * E18 }),
        maker({ orderId: 'out', priceWei: 22n * (E18 / 10n), remainingToken0: 400n * E18 }),
      ],
    )
    expect(res.legs.map((l) => l.makerOrderId)).toEqual(['in'])
    expect(res.remainderToken0).toBe(460n * E18)
  })

  it('跳过自成交与零剩余档位', () => {
    const res = matchTaker(
      { trader: T, side: 'buy', priceWei: 3n * E18, amountToken0: 10n * E18 },
      [
        maker({ orderId: 'self', trader: T.toLowerCase() }),
        maker({ orderId: 'empty', remainingToken0: 0n }),
        maker({ orderId: 'ok', remainingToken0: 4n * E18 }),
      ],
    )
    expect(res.legs.map((l) => l.makerOrderId)).toEqual(['ok'])
    expect(res.remainderToken0).toBe(6n * E18)
  })
})

describe('fromEvaluated 剩余量换算（maker 付款视角记账）', () => {
  const base = {
    orderId: 'x',
    pair: 'BTC/USDT',
    trader: B,
    sources: ['node'],
    raw: {},
    validity: 'VALID',
    chainKnown: true,
    lifecycle: 'PARTIAL',
    conflict: false,
    reasons: [],
    tradableBlockers: [],
    lockState: 'locked',
    badSignatureCopies: [],
  } as unknown as EvaluatedOrder

  it('SELL maker：剩余 Token0 = remainingIn', () => {
    const o = {
      ...base,
      side: 'sell' as const,
      amountIn: (100n * E18).toString(),
      amountOut: (200n * E18).toString(),
      remainingIn: (70n * E18).toString(),
      remainingOut: (140n * E18).toString(),
      price: (2n * E18).toString(),
      timestamp: 1,
      expiresAt: 2,
      nonce: 0,
    }
    expect(makerRemainingToken0(o)).toBe(70n * E18)
  })

  it('BUY maker：filledOut 记已收 Token0，剩余 = amountIn − (amountOut − remainingOut)', () => {
    // 买 100 Token0 @2.0（总额 200 quote），已收 30 Token0：
    // filledOut=30e18 → remainingOut = 200−30 = 170（evaluate 的代数口径）
    const o = {
      ...base,
      side: 'buy' as const,
      amountIn: (100n * E18).toString(),
      amountOut: (200n * E18).toString(),
      remainingIn: (40n * E18).toString(), // evaluate 的混合口径值，本换算不用它
      remainingOut: (170n * E18).toString(),
      price: (2n * E18).toString(),
      timestamp: 1,
      expiresAt: 2,
      nonce: 0,
    }
    expect(makerRemainingToken0(o)).toBe(70n * E18)
  })
})

describe('prune（预检剔腿 + 档位上限）', () => {
  it('整批模拟通过 → 全保留、无剔除', async () => {
    const out = await simulateAndPrune([1, 2], async () => {}, async () => null)
    expect(out.batchSimOk).toBe(true)
    expect(out.kept).toEqual([1, 2])
    expect(out.pruned).toEqual([])
  })

  it('整批不过 → 逐腿剔除失败腿，余下整批通过才提交', async () => {
    const out = await simulateAndPrune(
      [1, 2, 3],
      async (batch) => {
        if (batch.includes(2)) throw new Error('leg2 stale')
      },
      async (one) => (one === 2 ? 'expired' : null),
    )
    expect(out.batchSimOk).toBe(true)
    expect(out.kept).toEqual([1, 3])
    expect(out.pruned).toEqual([{ index: 1, reason: 'expired' }])
  })

  it('逐腿都过但整批仍不过（组合性失败）→ batchSimOk=false，整单不提交', async () => {
    const out = await simulateAndPrune(
      [1, 2],
      async () => {
        throw new Error('batch-level failure')
      },
      async () => null,
    )
    expect(out.batchSimOk).toBe(false)
  })

  it('全腿被剔 → batchSimOk=false', async () => {
    const out = await simulateAndPrune(
      [1],
      async () => {
        throw new Error('x')
      },
      async () => 'bad',
    )
    expect(out.batchSimOk).toBe(false)
    expect(out.kept).toEqual([])
  })

  it('档位上限与合约 MAX_BATCH_SIZE 对齐为 50，超限截断并计数', () => {
    expect(MAX_BATCH_LEGS).toBe(50)
    const legs = Array.from({ length: 55 }, (_, i) => i)
    const { capped, overflow } = capLegs(legs)
    expect(capped.length).toBe(50)
    expect(overflow).toBe(5)
  })
})

describe('fills（与节点 TradeToFill 同口径）', () => {
  const CHAIN = 11155111
  const takerData: OrderData = {
    orderId: 't1',
    userAddress: T,
    tokenIn: '0x1111111111111111111111111111111111111111',
    tokenOut: '0x2222222222222222222222222222222222222222',
    amountIn: (50n * E18).toString(),
    amountOut: (100n * E18).toString(),
    price: (2n * E18).toString(),
    timestamp: 1700000000,
    expiresAt: 1700086400,
    nonce: 0,
    side: 0,
  }

  it('maker=SELL：fill.tokenIn=Token0、amountIn=qty0、amountOut=qty1；maker 签名 side 透传', () => {
    // maker 原料行：经 buildSignedOrderData 重构（pair BTC/USDT @ Sepolia 登记代币）
    const tokens = getPairTokens(CHAIN, 'BTC/USDT')!
    const makerEv = {
      orderId: 'mSell',
      raw: {
        // 第 51 轮：单源后 fills 只读中继副本（原夹具挂在 node 键下）
        relay: {
          orderId: 'mSell',
          trader: B,
          pair: 'BTC/USDT',
          side: 'sell',
          price: (2n * E18).toString(),
          amount: (100n * E18).toString(),
          filled: '0',
          status: 'open',
          nonce: 0,
          createdAt: 1700000000,
          expiresAt: 1700086400,
          signature: '0xmakerSig',
        },
      },
    } as unknown as EvaluatedOrder
    const fill = buildLegFill(
      {
        makerOrderId: 'mSell',
        makerTrader: B,
        priceWei: 2n * E18,
        qtyToken0: 10n * E18,
        quoteAmount: 20n * E18,
      },
      {
        chainId: CHAIN,
        token0: tokens.base,
        token1: tokens.quote,
        takerData,
        takerSignature: '0xtakerSig',
        makersByOrderId: new Map([['mSell', makerEv]]),
      },
    )
    expect(fill).not.toBeNull()
    expect(fill!.tokenIn).toBe(tokens.base)
    expect(fill!.amountIn).toBe(10n * E18)
    expect(fill!.amountOut).toBe(20n * E18)
    expect(fill!.makerOrder.order.side).toBe(1n)
    expect(fill!.makerOrder.signature).toBe('0xmakerSig')
    expect(fill!.takerOrder.order.side).toBe(0n)
    expect(fill!.gasReimburseIn).toBe(0n)
  })

  it('maker 原料缺失 → null（调用方计数剔腿）', () => {
    const fill = buildLegFill(
      { makerOrderId: 'nope', makerTrader: B, priceWei: 1n, qtyToken0: 1n, quoteAmount: 1n },
      {
        chainId: CHAIN,
        token0: A,
        token1: B,
        takerData,
        takerSignature: '0x',
        makersByOrderId: new Map(),
      },
    )
    expect(fill).toBeNull()
  })
})

describe('executeFrontendMatch 数据源故障区分（第 52 轮 A5）', () => {
  const CHAIN = 11155111
  const PAIR = 'ETH/USDT'
  const taker: OrderData = {
    orderId: 't-a5',
    userAddress: T,
    tokenIn: A,
    tokenOut: B,
    amountIn: (10n * E18).toString(),
    amountOut: (20n * E18).toString(),
    price: (2n * E18).toString(),
    timestamp: 1700000000,
    expiresAt: 1700086400,
    nonce: 0,
    side: 0,
  }
  const req = {
    chainId: CHAIN,
    pair: PAIR,
    takerData: taker,
    takerSignature: '0x',
    signer: {} as FrontendMatchRequest['signer'],
  }

  const emptyBookAdapter: BookAdapter = {
    async fetchBook(chainId, pair) {
      return {
        source: 'relay',
        chainId,
        pair,
        bids: [],
        asks: [],
        complete: true,
        fetchedAt: Date.now(),
      }
    },
  }
  const failingBookAdapter: BookAdapter = {
    async fetchBook() {
      throw new Error('relay down')
    },
  }
  const healthyChain: ChainStateReader = {
    async snapshot(chainId) {
      return {
        chainId,
        blockNumber: 1000n,
        blockTimestamp: 1700000000,
        stale: false,
        states: new Map(),
        missing: new Set(),
      }
    },
  }
  const failingChain: ChainStateReader = {
    async snapshot() {
      throw new Error('rpc down')
    },
  }
  const staleChain: ChainStateReader = {
    async snapshot(chainId) {
      return {
        chainId,
        blockNumber: 1000n,
        blockTimestamp: 1700000000,
        stale: true,
        states: new Map(),
        missing: new Set(),
      }
    },
  }

  it('中继簿拉取失败 → aborted + 数据源不可用文案（不误报暂无可成交）', async () => {
    const out = await executeFrontendMatch(req, {
      relayAdapter: failingBookAdapter,
      chainReader: healthyChain,
    })
    expect(out.status).toBe('aborted')
    expect(out.message).toContain('暂不可用')
    expect(out.message).toContain('未撮合')
    expect(out.message).not.toContain('暂无可成交订单')
  })

  it('链上快照读取失败 → aborted + 数据源不可用文案', async () => {
    const out = await executeFrontendMatch(req, {
      relayAdapter: emptyBookAdapter,
      chainReader: failingChain,
    })
    expect(out.status).toBe('aborted')
    expect(out.message).toContain('暂不可用')
    expect(out.message).not.toContain('暂无可成交订单')
  })

  it('链上快照过旧（chainOk=false）→ aborted + 数据源不可用文案', async () => {
    const out = await executeFrontendMatch(req, {
      relayAdapter: emptyBookAdapter,
      chainReader: staleChain,
    })
    expect(out.status).toBe('aborted')
    expect(out.message).toContain('暂不可用')
  })

  it('簿与链都健康、簿为空 → 仍是 no-match（干净空簿不被误报成故障）', async () => {
    const out = await executeFrontendMatch(req, {
      relayAdapter: emptyBookAdapter,
      chainReader: healthyChain,
    })
    expect(out.status).toBe('no-match')
    expect(out.message).toBe('当前对手盘暂无可成交订单，订单已留簿。')
  })
})
