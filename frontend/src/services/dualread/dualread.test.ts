/**
 * 第 34 轮双读隔离测试：三源（节点/公告栏/RPC）全部 mock，
 * 订单用真实私钥签名（Hardhat 测试账户 #0），验签走生产代码路径。
 * 覆盖：状态冲突、RPC 故障→UNKNOWN、分页截断、部分成交剩余量、
 * 链上时间过期、软撤单（单源消失不推断撤销）、故障恢复、指标口径。
 */
import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'
import {
  ORDER_TYPES,
  getEIP712Domain,
  type OrderData,
} from '../orderSigningTypes'
import { buildSignedOrderData, computeOrderDigest, hashOrderWithDomain } from './digest'
import { createRelayBookAdapter, toRawOrder } from './adapters'
import {
  assembleChainState,
  createChainStateReader,
  type ChainTransport,
  type StateCallResult,
} from './chainState'
import {
  evaluateCandidate,
  mergeBooks,
  prepareCandidates,
} from './evaluate'
import { ShadowObserver, computeShadowMetrics } from './metrics'
import { runDualReadRound, type DualReadDeps } from './index'
import type {
  ChainOrderState,
  ChainSnapshot,
  RawOrder,
  SourceBook,
} from './types'
import type { BookAdapter } from './adapters'
import type { ChainStateReader } from './chainState'

const CHAIN = 11155111
const PAIR = 'BTC/USDT'
const PK0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const PK1 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const wallet0 = new ethers.Wallet(PK0)
const wallet1 = new ethers.Wallet(PK1)
const TRADER = wallet0.address // 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

const E18 = 10n ** 18n

function messageOf(d: OrderData) {
  return {
    orderId: d.orderId,
    userAddress: d.userAddress,
    tokenIn: d.tokenIn,
    tokenOut: d.tokenOut,
    amountIn: d.amountIn,
    amountOut: d.amountOut,
    price: d.price,
    timestamp: d.timestamp,
    expiresAt: d.expiresAt,
    nonce: d.nonce,
  }
}

let seq = 0
async function signedRaw(over: Partial<RawOrder> = {}, signer = wallet0): Promise<RawOrder> {
  seq += 1
  const raw: RawOrder = {
    orderId: `ord_${seq}`,
    trader: TRADER,
    pair: PAIR,
    side: 'sell',
    price: (2n * E18).toString(),
    amount: (100n * E18).toString(),
    filled: '0',
    status: 'open',
    nonce: 0,
    createdAt: 1700000000,
    expiresAt: 1700086400,
    signature: '',
    ...over,
  }
  const data = buildSignedOrderData(raw, CHAIN)
  if (!data) throw new Error('unbuildable test order')
  raw.signature = await signer.signTypedData(
    getEIP712Domain(CHAIN) as ethers.TypedDataDomain,
    ORDER_TYPES as unknown as Record<string, ethers.TypedDataField[]>,
    messageOf(data),
  )
  return raw
}

function book(source: 'node' | 'relay', rows: RawOrder[], complete = true): SourceBook {
  return {
    source,
    chainId: CHAIN,
    pair: PAIR,
    bids: rows.filter((r) => r.side === 'buy'),
    asks: rows.filter((r) => r.side === 'sell'),
    complete,
    fetchedAt: Date.now(),
  }
}

const LOCK = {
  user: TRADER,
  token: '0x1111111111111111111111111111111111111111',
  remaining: 100n * E18,
  expiresAt: 1700086400n,
}

function state(over: Partial<ChainOrderState> = {}): ChainOrderState {
  return {
    filledIn: 0n,
    filledOut: 0n,
    nonceUsed: false,
    lock: LOCK,
    tombstone: { user: TRADER, token: LOCK.token },
    ...over,
  }
}

function snapshot(
  states: Map<string, ChainOrderState>,
  over: Partial<ChainSnapshot> = {},
): ChainSnapshot {
  return {
    chainId: CHAIN,
    blockNumber: 100n,
    blockTimestamp: 1700001000,
    stale: false,
    states,
    missing: new Set(),
    ...over,
  }
}

async function prepareOne(raws: { node?: RawOrder; relay?: RawOrder }) {
  const books: SourceBook[] = []
  if (raws.node) books.push(book('node', [raws.node]))
  if (raws.relay) books.push(book('relay', [raws.relay]))
  const prepared = await prepareCandidates(CHAIN, books)
  expect(prepared.candidates.length).toBe(1)
  return prepared.candidates[0]
}

function digestOf(raw: RawOrder): string {
  const data = buildSignedOrderData(raw, CHAIN)!
  return computeOrderDigest(data, CHAIN).toLowerCase()
}

describe('digest 重算（规范向量与公式）', () => {
  it('命中 docs/eip712-order-spec.md §6 规范测试向量', () => {
    const domain = {
      name: '比特100',
      version: '1',
      chainId: 31337,
      verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    }
    const data: OrderData = {
      orderId: 'order_vector_1',
      userAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      tokenIn: '0x1111111111111111111111111111111111111111',
      tokenOut: '0x2222222222222222222222222222222222222222',
      amountIn: '100000000000000000000',
      amountOut: '200000000000000000000',
      price: '2000000000000000000',
      timestamp: 1700000000,
      expiresAt: 1700086400,
      nonce: 0,
    }
    expect(hashOrderWithDomain(domain, data)).toBe(
      '0x6a3c557cec5b51cb843652a7a36b96bccc9eecc4eca030745110706cbfc8d2f1',
    )
  })

  it('amountOut 按第 29 轮规范整数公式重算；expiresAt=0 推导 7 天', () => {
    const raw: RawOrder = {
      orderId: 'x',
      trader: TRADER,
      pair: PAIR,
      side: 'buy',
      price: (3n * E18).toString(),
      amount: (7n * E18).toString(),
      filled: '0',
      status: 'open',
      nonce: 5,
      createdAt: 1700000000,
      expiresAt: 0,
      signature: '0x',
    }
    const data = buildSignedOrderData(raw, CHAIN)!
    expect(data.amountOut).toBe((21n * E18).toString())
    expect(data.expiresAt).toBe(1700000000 + 7 * 24 * 3600)
    expect(buildSignedOrderData({ ...raw, pair: 'XXX/USDT' }, CHAIN)).toBeNull()
  })
})

describe('状态机（mock 链上快照）', () => {
  it('有效开放单 → VALID/OPEN，剩余量为全额', async () => {
    const raw = await signedRaw()
    const cand = await prepareOne({ node: raw })
    const ev = evaluateCandidate(cand, snapshot(new Map([[digestOf(raw), state()]])))
    expect(ev.validity).toBe('VALID')
    expect(ev.lifecycle).toBe('OPEN')
    expect(ev.remainingIn).toBe((100n * E18).toString())
    expect(ev.lockState).toBe('locked')
  })

  it('部分成交 → VALID/PARTIAL，剩余量按链上累计成交（规范口径）', async () => {
    const raw = await signedRaw()
    const cand = await prepareOne({ node: raw })
    const ev = evaluateCandidate(
      cand,
      snapshot(new Map([[digestOf(raw), state({ filledIn: 30n * E18, filledOut: 60n * E18 })]])),
    )
    expect(ev.validity).toBe('VALID')
    expect(ev.lifecycle).toBe('PARTIAL')
    expect(ev.remainingIn).toBe((70n * E18).toString())
    expect(ev.remainingOut).toBe((140n * E18).toString())
  })

  it('链上时间过期 → INVALID/EXPIRED（只看区块 timestamp）', async () => {
    const raw = await signedRaw()
    const cand = await prepareOne({ node: raw })
    const ev = evaluateCandidate(
      cand,
      snapshot(new Map([[digestOf(raw), state()]]), { blockTimestamp: 1700086401 }),
    )
    expect(ev.validity).toBe('INVALID')
    expect(ev.reasons).toContain('EXPIRED')
  })

  it('全成交 → FILLED 终局，不进可成交集', async () => {
    const raw = await signedRaw()
    const cand = await prepareOne({ node: raw })
    const snap = snapshot(new Map([[digestOf(raw), state({ filledIn: 100n * E18, filledOut: 200n * E18 })]]))
    const ev = evaluateCandidate(cand, snap)
    expect(ev.lifecycle).toBe('FILLED')
    const view = mergeBooks(CHAIN, PAIR, { candidates: [cand], unbuildable: [] }, snap)
    expect(view.tradeable.length).toBe(0)
  })

  it('nonce 被占用且本单无成交 → INVALID/NONCE_CONSUMED', async () => {
    const raw = await signedRaw()
    const cand = await prepareOne({ node: raw })
    const ev = evaluateCandidate(
      cand,
      snapshot(new Map([[digestOf(raw), state({ nonceUsed: true })]])),
    )
    expect(ev.validity).toBe('INVALID')
    expect(ev.reasons).toContain('NONCE_CONSUMED')
  })

  it('墓碑 + 无活跃锁 → INVALID/LOCK_RELEASED（撤单/释放）', async () => {
    const raw = await signedRaw()
    const cand = await prepareOne({ node: raw })
    const ev = evaluateCandidate(
      cand,
      snapshot(new Map([[digestOf(raw), state({ lock: null })]])),
    )
    expect(ev.validity).toBe('INVALID')
    expect(ev.lifecycle).toBe('CANCELLED')
    expect(ev.lockState).toBe('released')
  })

  it('无锁无墓碑 → VALID 但标 unlocked（公告栏先行口径）', async () => {
    const raw = await signedRaw()
    const cand = await prepareOne({ relay: raw })
    const ev = evaluateCandidate(
      cand,
      snapshot(new Map([[digestOf(raw), state({ lock: null, tombstone: null })]])),
    )
    expect(ev.validity).toBe('VALID')
    expect(ev.lockState).toBe('unlocked')
    expect(ev.reasons).toContain('LOCK_MISSING')
  })

  it('签名伪造（他人私钥冒签）且链上验签未过 → INVALID/BAD_SIGNATURE', async () => {
    const raw = await signedRaw({}, wallet1)
    const cand = await prepareOne({ node: raw })
    expect(cand.anyLocalValid).toBe(false)
    const ev = evaluateCandidate(
      cand,
      snapshot(new Map([[digestOf(raw), state({ chainSignatureValid: false })]])),
    )
    expect(ev.validity).toBe('INVALID')
    expect(ev.reasons).toContain('BAD_SIGNATURE')
  })

  it('本地验签未过但链上 ERC-1271 验签通过 → 按有效继续判定', async () => {
    const raw = await signedRaw()
    raw.signature = '0x1234' // 合约签名者本地 ecrecover 必然失败
    const cand = await prepareOne({ node: raw })
    expect(cand.anyLocalValid).toBe(false)
    const ev = evaluateCandidate(
      cand,
      snapshot(new Map([[digestOf(raw), state({ chainSignatureValid: true })]])),
    )
    expect(ev.validity).toBe('VALID')
  })

  it('RPC 故障（无快照）→ UNKNOWN；区块过旧 → UNKNOWN；状态缺失 → UNKNOWN', async () => {
    const raw = await signedRaw()
    const cand = await prepareOne({ node: raw })
    expect(evaluateCandidate(cand, null).reasons).toContain('CHAIN_UNAVAILABLE')
    expect(
      evaluateCandidate(cand, snapshot(new Map([[digestOf(raw), state()]]), { stale: true }))
        .validity,
    ).toBe('UNKNOWN')
    const missingSnap = snapshot(new Map(), { missing: new Set([digestOf(raw)]) })
    const ev = evaluateCandidate(cand, missingSnap)
    expect(ev.validity).toBe('UNKNOWN')
    expect(ev.reasons).toContain('CHAIN_STATE_MISSING')
  })

  it('状态冲突：同 digest 两源 side 不一致 → CONFLICT，剔出可成交集', async () => {
    const nodeRaw = await signedRaw({ side: 'sell' })
    const relayRaw = { ...nodeRaw, side: 'buy' as const } // side 未签名，可被源改写
    const prepared = await prepareCandidates(CHAIN, [
      book('node', [nodeRaw]),
      book('relay', [{ ...relayRaw, side: 'buy' }]),
    ])
    // relay 侧行 side=buy 会进 bids，但重构与 digest 不受 side 影响 → 同一候选
    expect(prepared.candidates.length).toBe(1)
    const cand = prepared.candidates[0]
    const snap = snapshot(new Map([[digestOf(nodeRaw), state()]]))
    const ev = evaluateCandidate(cand, snap)
    expect(ev.conflict).toBe(true)
    expect(ev.validity).toBe('UNKNOWN')
    const view = mergeBooks(CHAIN, PAIR, prepared, snap)
    expect(view.tradeable.length).toBe(0)
    expect(view.all.length).toBe(1)
  })

  it('软撤单：订单只在一源消失不推断撤销——仍按链上状态判 VALID', async () => {
    const raw = await signedRaw()
    const cand = await prepareOne({ node: raw }) // relay 侧已消失
    const ev = evaluateCandidate(cand, snapshot(new Map([[digestOf(raw), state()]])))
    expect(ev.validity).toBe('VALID')
    expect(ev.sources).toEqual(['node'])
  })
})

describe('公告栏适配器分页完整度', () => {
  it('单侧满 100 行 → complete=false；行规范化丢弃无签名关键字段缺失行', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      orderId: `r${i}`,
      trader: TRADER,
      pair: PAIR,
      side: 'buy',
      price: '1000000000000000000',
      amount: '1000000000000000000',
      filled: '0',
      status: 'open',
      nonce: 0,
      createdAt: 1700000000,
      expiresAt: 1700086400,
      signature: '0xabc',
      chainId: CHAIN,
      digest: '0xdeadbeef', // 数据源自报 digest —— 必须被忽略（本地重算）
    }))
    const adapter = createRelayBookAdapter('https://relay.example', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ bids: rows, asks: [] }),
    }))
    const res = await adapter.fetchBook(CHAIN, PAIR)
    expect(res.complete).toBe(false)
    expect(res.bids.length).toBe(100)
    expect(toRawOrder({ orderId: 'x' })).toBeNull()
  })
})

describe('链上读取器（mock transport）', () => {
  it('同区块二次快照复用缓存；部分失败 digest 进 missing', async () => {
    let multicallCalls = 0
    const transport: ChainTransport = {
      async getLatestBlock() {
        return { number: 100n, timestamp: 1700001000 }
      },
      async multicall(calls) {
        multicallCalls += 1
        return calls.map((c): StateCallResult => {
          if (c.functionName === 'orderFilledIn')
            return { status: 'success', result: 0n }
          if (c.functionName === 'orderFilledOut')
            return { status: 'success', result: 0n }
          if (c.functionName === 'usedNonces') return { status: 'success', result: false }
          if (c.functionName === 'orderLocks')
            return {
              status: 'success',
              result: [TRADER, LOCK.token, 100n * E18, 1700086400n],
            }
          return { status: 'success', result: [TRADER, LOCK.token] }
        })
      },
    }
    const reader = createChainStateReader(() => transport, () => 1700001000)
    const req = [{ digest: '0x' + 'ab'.repeat(32), userAddress: TRADER, nonce: 0 }]
    const s1 = await reader.snapshot(CHAIN, req)
    expect(s1.states.size).toBe(1)
    const s2 = await reader.snapshot(CHAIN, req)
    expect(s2.states.size).toBe(1)
    expect(multicallCalls).toBe(1) // 第二次同区块 → 缓存命中，零新增 RPC

    const assembled = assembleChainState([
      { status: 'failure' },
      { status: 'success', result: 0n },
      { status: 'success', result: false },
      { status: 'success', result: [TRADER, LOCK.token, 0n, 0n] },
      { status: 'success', result: [TRADER, LOCK.token] },
    ])
    expect(assembled).toBeNull()
  })
})

describe('影子指标口径', () => {
  it('冲突率/一致率/误判率/独有率/簿差异按定义计算', async () => {
    // A: 两源共同、链上部分成交 30，源自报 filled 与链上一致（node）/不一致场景分开验
    const a = await signedRaw({ orderId: 'mA' })
    const aRelay = { ...a, filled: (30n * E18).toString(), status: 'partial' }
    const aNode = { ...a, filled: (30n * E18).toString(), status: 'partial' }
    // B: 仅节点有，源自报 open 但链上已全成交 → 朴素误判
    const b = await signedRaw({ orderId: 'mB' })
    // C: 两源共同但 side 冲突
    const c = await signedRaw({ orderId: 'mC', side: 'sell' })
    const cRelay = { ...c, side: 'buy' as const }
    const prepared = await prepareCandidates(CHAIN, [
      book('node', [aNode, b, c]),
      book('relay', [aRelay, cRelay]),
    ])
    const states = new Map<string, ChainOrderState>([
      [digestOf(a), state({ filledIn: 30n * E18, filledOut: 60n * E18 })],
      [digestOf(b), state({ filledIn: 100n * E18, filledOut: 200n * E18 })],
      [digestOf(c), state()],
    ])
    const snap = snapshot(states)
    const view = mergeBooks(CHAIN, PAIR, prepared, snap)
    const observer = new ShadowObserver()
    observer.recordAvailability('node', true)
    observer.recordAvailability('relay', true)
    observer.recordAvailability('rpc', true)
    observer.observeOrders(view.all, 1700002000_000)
    const m = computeShadowMetrics(
      {
        views: [view],
        books: [{ pair: PAIR, node: book('node', [aNode, b, c]), relay: book('relay', [aRelay, cRelay]) }],
        chainOk: true,
        nowMs: 1700002000_000,
      },
      observer,
    )
    expect(m.totals).toEqual({ orders: 3, common: 2, nodeOnly: 1, relayOnly: 0 })
    expect(m.conflictRateAmongCommon).toEqual({ num: 1, den: 2, rate: 0.5 })
    // 一致率分母 = 有链上判定的共同单 = A、C 两单；C 冲突 → 不一致；A 一致
    expect(m.stateConsistencyRate).toEqual({ num: 1, den: 2, rate: 0.5 })
    expect(m.singleSourceRatio.rate).toBeCloseTo(1 / 3)
    // 朴素集：A(open/partial)、B(open)、C(open) = 3；链上 INVALID 只有 B
    expect(m.falseTradeableRate).toEqual({ num: 1, den: 3, rate: 1 / 3 })
    expect(m.chainInvalidRatio).toEqual({ num: 1, den: 2, rate: 0.5 })
    expect(m.availability.node).toEqual({ num: 1, den: 1, rate: 1 })
    expect(m.paginationComplete).toEqual({ node: true, relay: true })
    const sellDiff = m.bookDiffByPairSide.find((d) => d.side === 'sell')!
    expect(sellDiff.onlyNode).toBe(1) // B 仅节点
    expect(sellDiff.trustworthy).toBe(true)
    // 发现延迟样本：A/B/C 均被观察到（nowMs - createdAt*1000 = 2000 秒）
    expect(m.discoveryLatencyMs.node.samples).toBe(3)
    expect(m.discoveryLatencyMs.node.median).toBe(2000_000)
  })

  it('分页截断时簿差异条目标 trustworthy=false', async () => {
    const a = await signedRaw({ orderId: 'mT' })
    const prepared = await prepareCandidates(CHAIN, [book('node', [a]), book('relay', [a], false)])
    const view = mergeBooks(
      CHAIN,
      PAIR,
      prepared,
      snapshot(new Map([[digestOf(a), state()]])),
    )
    const observer = new ShadowObserver()
    const m = computeShadowMetrics(
      {
        views: [view],
        books: [{ pair: PAIR, node: book('node', [a]), relay: book('relay', [a], false) }],
        chainOk: true,
        nowMs: Date.now(),
      },
      observer,
    )
    expect(m.paginationComplete.relay).toBe(false)
    expect(m.bookDiffByPairSide.every((d) => d.trustworthy === false)).toBe(true)
  })
})

describe('编排与故障恢复', () => {
  function depsWith(opts: {
    relayFails?: boolean
    rpcFails?: boolean
    rows: RawOrder[]
  }): DualReadDeps {
    const nodeAdapter: BookAdapter = {
      async fetchBook(chainId, pair) {
        return { ...book('node', opts.rows), chainId, pair }
      },
    }
    const relayAdapter: BookAdapter = {
      async fetchBook(chainId, pair) {
        if (opts.relayFails) throw new Error('relay down')
        return { ...book('relay', opts.rows), chainId, pair }
      },
    }
    const states = new Map<string, ChainOrderState>()
    for (const r of opts.rows) states.set(digestOf(r), state())
    const chainReader: ChainStateReader = {
      async snapshot(chainId) {
        if (opts.rpcFails) throw new Error('rpc down')
        return snapshot(states, { chainId })
      },
    }
    return { mode: 'shadow', nodeAdapter, relayAdapter, chainReader, observer: new ShadowObserver() }
  }

  it('disabled 模式不拉任何源', async () => {
    const round = await runDualReadRound({ mode: 'disabled' }, CHAIN, [PAIR])
    expect(round.views.length).toBe(0)
    expect(round.metrics).toBeNull()
  })

  it('公告栏故障轮次指标降级、下一轮恢复（可用率分开统计）', async () => {
    const raw = await signedRaw({ orderId: 'fr1' })
    const observer = new ShadowObserver()
    const base = depsWith({ rows: [raw], relayFails: true })
    base.observer = observer
    const r1 = await runDualReadRound(base, CHAIN, [PAIR])
    expect(r1.errors.relay).toContain('relay down')
    expect(r1.metrics?.availability.relay).toEqual({ num: 0, den: 1, rate: 0 })
    expect(r1.views[0].tradeable.length).toBe(1) // 节点单仍可评估

    const base2 = depsWith({ rows: [raw] })
    base2.observer = observer
    const r2 = await runDualReadRound(base2, CHAIN, [PAIR])
    expect(r2.metrics?.availability.relay).toEqual({ num: 1, den: 2, rate: 0.5 })
    expect(r2.views[0].all[0].sources).toEqual(['node', 'relay'])
  })

  it('RPC 故障 → 全部 UNKNOWN、不进可成交集', async () => {
    const raw = await signedRaw({ orderId: 'fr2' })
    const round = await runDualReadRound(depsWith({ rows: [raw], rpcFails: true }), CHAIN, [PAIR])
    expect(round.chainOk).toBe(false)
    expect(round.views[0].all[0].validity).toBe('UNKNOWN')
    expect(round.views[0].tradeable.length).toBe(0)
    expect(round.metrics?.unknownRatio.rate).toBe(1)
  })
})
