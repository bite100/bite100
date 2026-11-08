/**
 * 第 34 轮双读隔离测试：三源（节点/公告栏/RPC）全部 mock，
 * 订单用真实私钥签名（Hardhat 测试账户 #0），验签走生产代码路径。
 * 覆盖：状态冲突、RPC 故障→UNKNOWN、分页截断、部分成交剩余量、
 * 链上时间过期、软撤单（单源消失不推断撤销）、故障恢复、指标口径。
 */
import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'
import { getPairTokens } from '../../config/pairs'
import {
  ORDER_TYPES,
  getEIP712Domain,
  type OrderData,
} from '../orderSigningTypes'
import { buildSignedOrderData, computeOrderDigest, hashOrderWithDomain } from './digest'
import { createNodeBookAdapter, createRelayBookAdapter, normalizeBookRows, toRawOrder } from './adapters'
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
import { orderSideProof } from './sideProof'
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

// 锁仓夹具按协议真实口径：卖单义务锁 tokenIn（交易对 base）、买单义务
// 锁 tokenOut（quote），见 node/internal/settlement/lock.go
// ObligationForOrder。第 36 轮起锁仓只用于派生「落锁义务方向」作观察
// 旗标（deriveSideFromLock），任意假地址会让派生恒为 null、旗标永不
// 触发，故夹具必须用真实交易对代币。
const PAIR_TOKENS = getPairTokens(CHAIN, PAIR)!
const LOCK = {
  user: TRADER,
  token: PAIR_TOKENS.base,
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

  it('第 35 轮 D3：amountIn=0 / price=0 / amountOut 舍为 0 → 不可重构', () => {
    const raw: RawOrder = {
      orderId: 'x',
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
      signature: '0x',
    }
    expect(buildSignedOrderData({ ...raw, amount: '0' }, CHAIN)).toBeNull()
    expect(buildSignedOrderData({ ...raw, price: '0' }, CHAIN)).toBeNull()
    // 边界：amountIn=1 wei、price=1 wei 均非零，但 amountOut = 1×1/1e18 舍为 0
    expect(buildSignedOrderData({ ...raw, amount: '1', price: '1' }, CHAIN)).toBeNull()
    // 边界内侧：amountOut 恰为 1 wei → 可重构
    expect(buildSignedOrderData({ ...raw, amount: E18.toString(), price: '1' }, CHAIN)).not.toBeNull()
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

  it('无锁无墓碑 + 单源（公告栏先行）→ 观察 VALID/unlocked，但认证被 SIDE_UNPROVABLE 阻断', async () => {
    // 第 34 轮口径判 VALID/unlocked；第 35 轮 D2 曾降为 UNKNOWN/
    // SIDE_UNCORROBORATED；第 36 轮起口径分离：观察分类回到 VALID
    // （状态机+签名+链上状态都通过），不可成交的原因单独记在
    // tradableBlockers——当前协议方向不可证（protocol.ts）。
    const raw = await signedRaw()
    const cand = await prepareOne({ relay: raw })
    const ev = evaluateCandidate(
      cand,
      snapshot(new Map([[digestOf(raw), state({ lock: null, tombstone: null })]])),
    )
    expect(ev.validity).toBe('VALID')
    expect(ev.reasons).not.toContain('SIDE_UNCORROBORATED')
    expect(ev.lockState).toBe('unlocked')
    expect(ev.tradableBlockers).toContain('SIDE_UNPROVABLE')
  })

  it('单源 + 锁仓义务方向与自报一致 → 观察 VALID；锁不再构成认证（第 36 轮 N1）', async () => {
    const raw = await signedRaw() // side=sell，夹具锁 tokenIn(base) → 派生 sell
    const cand = await prepareOne({ relay: raw })
    const ev = evaluateCandidate(
      cand,
      snapshot(new Map([[digestOf(raw), state()]])),
    )
    expect(ev.validity).toBe('VALID')
    expect(ev.lockState).toBe('locked')
    // 锁仓方向由落锁调用者自填（lockForOrder 无许可），相符什么都不证明：
    // 认证仍被 SIDE_UNPROVABLE 阻断，不进可成交集。
    expect(ev.tradableBlockers).toContain('SIDE_UNPROVABLE')
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

describe('第 35 轮 D1：分页完整度进入状态机', () => {
  async function evalWithBooks(books: SourceBook[], raw: RawOrder) {
    const prepared = await prepareCandidates(CHAIN, books)
    expect(prepared.candidates.length).toBe(1)
    const snap = snapshot(new Map([[digestOf(raw), state()]]))
    const ev = evaluateCandidate(prepared.candidates[0], snap)
    const view = mergeBooks(CHAIN, PAIR, prepared, snap)
    return { ev, view }
  }

  it('仅节点且节点分页不完整 → UNKNOWN/SOURCE_INCOMPLETE，不进可成交集', async () => {
    const raw = await signedRaw()
    const { ev, view } = await evalWithBooks([book('node', [raw], false)], raw)
    expect(ev.validity).toBe('UNKNOWN')
    expect(ev.reasons).toContain('SOURCE_INCOMPLETE')
    expect(view.tradeable.length).toBe(0)
  })

  it('仅公告栏且公告栏分页不完整 → UNKNOWN/SOURCE_INCOMPLETE', async () => {
    const raw = await signedRaw()
    const { ev, view } = await evalWithBooks([book('relay', [raw], false)], raw)
    expect(ev.validity).toBe('UNKNOWN')
    expect(ev.reasons).toContain('SOURCE_INCOMPLETE')
    expect(view.tradeable.length).toBe(0)
  })

  it('两源都在但两源都不完整 → UNKNOWN/SOURCE_INCOMPLETE', async () => {
    const raw = await signedRaw()
    const { ev } = await evalWithBooks(
      [book('node', [raw], false), book('relay', [raw], false)],
      raw,
    )
    expect(ev.validity).toBe('UNKNOWN')
    expect(ev.reasons).toContain('SOURCE_INCOMPLETE')
  })

  it('一源不完整、另一源完整 → 按完整来源判定，仍可 VALID', async () => {
    const raw = await signedRaw()
    const { ev } = await evalWithBooks(
      [book('node', [raw], false), book('relay', [raw], true)],
      raw,
    )
    expect(ev.validity).toBe('VALID')
    expect(ev.reasons).not.toContain('SOURCE_INCOMPLETE')
  })

  it('下一轮分页恢复完整 → 同单回到 VALID（恢复性）', async () => {
    const raw = await signedRaw()
    const first = await evalWithBooks([book('node', [raw], false)], raw)
    expect(first.ev.validity).toBe('UNKNOWN')
    const second = await evalWithBooks(
      [book('node', [raw], true), book('relay', [raw], true)],
      raw,
    )
    expect(second.ev.validity).toBe('VALID')
  })
})

describe('第 36 轮 N1/N3：方向不可证过渡期（观察照常、认证关闭）', () => {
  it('(a) 两源同写被改的 side、无锁 → 观察 VALID，但不可成交（SIDE_UNPROVABLE）', async () => {
    // N3 场景：节点与中继同吃一份广播，两份副本一致地写着被改写的
    // side——来源一致不是独立证据。第 35 轮口径下此单无锁时单源降级、
    // 双源反而漏过；第 36 轮起观察如实判 VALID，认证一律关闭。
    const raw = await signedRaw({ side: 'sell' })
    const flipped = { ...raw, side: 'buy' as const } // side 未签名：改写不改变 digest/验签
    const prepared = await prepareCandidates(CHAIN, [
      book('node', [flipped]),
      book('relay', [flipped]),
    ])
    expect(prepared.candidates.length).toBe(1)
    const snap = snapshot(
      new Map([[digestOf(raw), state({ lock: null, tombstone: null })]]),
    )
    const ev = evaluateCandidate(prepared.candidates[0], snap)
    expect(ev.conflict).toBe(false) // 两源彼此一致，冲突检查抓不到
    expect(ev.validity).toBe('VALID')
    expect(ev.reasons).not.toContain('SIDE_LOCK_MISMATCH') // 无锁可比，不编造旗标
    expect(ev.tradableBlockers).toContain('SIDE_UNPROVABLE')
    expect(mergeBooks(CHAIN, PAIR, prepared, snap).tradeable.length).toBe(0)
  })

  it('(b) 两源同写被改 side + 锁按调用者自选的反向义务落锁 → 仍不可成交', async () => {
    // N1 场景：攻击者（或任何人）对他人订单调用无许可的 lockForOrder，
    // 以 payWithTokenIn=false 按「买单义务」落锁（锁 tokenOut/quote），
    // 与被改写的自报 side=buy 恰好相符。第 35 轮口径会把这当作方向
    // 佐证放行；第 36 轮：相符什么都不证明，认证仍关。
    const raw = await signedRaw({ side: 'sell' })
    const flipped = { ...raw, side: 'buy' as const }
    const prepared = await prepareCandidates(CHAIN, [
      book('node', [flipped]),
      book('relay', [flipped]),
    ])
    const buyObligationLock = { ...LOCK, token: PAIR_TOKENS.quote }
    const snap = snapshot(
      new Map([[digestOf(raw), state({ lock: buyObligationLock })]]),
    )
    const ev = evaluateCandidate(prepared.candidates[0], snap)
    expect(ev.validity).toBe('VALID')
    expect(ev.reasons).not.toContain('SIDE_LOCK_MISMATCH') // 落锁义务与自报恰好相符
    expect(ev.tradableBlockers).toContain('SIDE_UNPROVABLE')
    expect(mergeBooks(CHAIN, PAIR, prepared, snap).tradeable.length).toBe(0)
  })

  it('(c) 两源一致的正常单（含共同声称 market）→ 观察全 VALID，认证全关', async () => {
    const plain = await signedRaw({ orderId: 'r36plain' })
    const mkt = await signedRaw({ orderId: 'r36mkt', execType: 'market' })
    const prepared = await prepareCandidates(CHAIN, [
      book('node', [plain, mkt]),
      book('relay', [plain, mkt]),
    ])
    const snap = snapshot(
      new Map([
        [digestOf(plain), state()],
        [digestOf(mkt), state()],
      ]),
    )
    const view = mergeBooks(CHAIN, PAIR, prepared, snap)
    expect(view.all.every((o) => o.validity === 'VALID')).toBe(true)
    expect(view.tradeable.length).toBe(0) // 过渡期可成交集按构造为空
    expect(
      view.all.every((o) => o.tradableBlockers.includes('SIDE_UNPROVABLE')),
    ).toBe(true)
  })

  it('(d) 仅节点携带被改写的 side（落锁义务 sell、节点写 buy）→ 观察旗标 SIDE_LOCK_MISMATCH，validity 不动', async () => {
    const raw = await signedRaw({ side: 'sell' })
    const flipped = { ...raw, side: 'buy' as const }
    const prepared = await prepareCandidates(CHAIN, [book('node', [flipped])])
    expect(prepared.candidates.length).toBe(1)
    const snap = snapshot(new Map([[digestOf(raw), state()]]))
    const ev = evaluateCandidate(prepared.candidates[0], snap)
    expect(ev.validity).toBe('VALID') // 旗标只是观察信号，不再降级
    expect(ev.reasons).toContain('SIDE_LOCK_MISMATCH')
    expect(mergeBooks(CHAIN, PAIR, prepared, snap).tradeable.length).toBe(0)
  })

  it('(d) 仅公告栏携带被改写的 side → 同样只记观察旗标', async () => {
    const raw = await signedRaw({ side: 'sell' })
    const flipped = { ...raw, side: 'buy' as const }
    const prepared = await prepareCandidates(CHAIN, [book('relay', [flipped])])
    const snap = snapshot(new Map([[digestOf(raw), state()]]))
    const ev = evaluateCandidate(prepared.candidates[0], snap)
    expect(ev.validity).toBe('VALID')
    expect(ev.reasons).toContain('SIDE_LOCK_MISMATCH')
    expect(mergeBooks(CHAIN, PAIR, prepared, snap).tradeable.length).toBe(0)
  })

  it('(d) 两源同写被改的 side、落锁义务为 sell → 旗标仍出现（冲突检查抓不到、旗标抓得到）', async () => {
    const raw = await signedRaw({ side: 'sell' })
    const flipped = { ...raw, side: 'buy' as const }
    const prepared = await prepareCandidates(CHAIN, [
      book('node', [flipped]),
      book('relay', [flipped]),
    ])
    expect(prepared.candidates.length).toBe(1)
    const ev = evaluateCandidate(
      prepared.candidates[0],
      snapshot(new Map([[digestOf(raw), state()]])),
    )
    expect(ev.conflict).toBe(false)
    expect(ev.validity).toBe('VALID')
    expect(ev.reasons).toContain('SIDE_LOCK_MISMATCH')
  })

  it('单源声称市价单（execType=market）→ 观察 VALID（第 36 轮起不再 EXEC_TYPE_UNPROVEN 降级）', async () => {
    const raw = await signedRaw({ execType: 'market' })
    const cand = await prepareOne({ node: raw })
    const ev = evaluateCandidate(
      cand,
      snapshot(new Map([[digestOf(raw), state()]])),
    )
    expect(ev.validity).toBe('VALID')
    expect(ev.reasons).not.toContain('EXEC_TYPE_UNPROVEN')
    expect(ev.tradableBlockers).toContain('SIDE_UNPROVABLE')
  })

  it('execType 一源写 limit、一源不写 → 同为缺省语义，不算冲突', async () => {
    const raw = await signedRaw()
    const withLimit = { ...raw, execType: 'limit' }
    const prepared = await prepareCandidates(CHAIN, [
      book('node', [withLimit]),
      book('relay', [raw]),
    ])
    const ev = evaluateCandidate(
      prepared.candidates[0],
      snapshot(new Map([[digestOf(raw), state()]])),
    )
    expect(ev.conflict).toBe(false)
    expect(ev.validity).toBe('VALID')
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

describe('第 38 轮：节点定点小数 amount 解析与丢弃计数', () => {
  const nodeRow = {
    orderId: 'soak_1',
    trader: TRADER,
    pair: PAIR,
    side: 'buy',
    price: '2000000000000000000000',
    amount: '1000000000000000.000000000000000000', // 节点撮合引擎 big.Float.Text('f', 18) 形态
    filled: '0.000000000000000000',
    status: 'open',
    nonce: 0,
    createdAt: 1700000000,
    expiresAt: 1700086400,
    signature: '0xabc',
  }

  it('全零小数 amount/filled 通过并归一化为整数串', () => {
    const o = toRawOrder(nodeRow)
    expect(o).not.toBeNull()
    expect(o!.amount).toBe('1000000000000000')
    expect(o!.filled).toBe('0')
    expect(o!.price).toBe('2000000000000000000000')
  })

  it('小数部分含非零数字 → 整行判无效（不静默截断）', () => {
    expect(toRawOrder({ ...nodeRow, amount: '1000000000000000.000000000000000001' })).toBeNull()
    expect(toRawOrder({ ...nodeRow, amount: '1.5' })).toBeNull()
  })

  it('纯整数串保持不变', () => {
    const o = toRawOrder({ ...nodeRow, amount: '1000000000000000000', filled: '0' })
    expect(o).not.toBeNull()
    expect(o!.amount).toBe('1000000000000000000')
  })

  it('normalizeBookRows 计数丢弃；节点适配器 SourceBook 带 rawRows/droppedRows', async () => {
    const bad = { ...nodeRow, orderId: 'bad', amount: '1.5' }
    const { orders, droppedRows } = normalizeBookRows([nodeRow, bad])
    expect(orders.length).toBe(1)
    expect(droppedRows).toBe(1)

    const adapter = createNodeBookAdapter(async () => ({
      data: { pair: PAIR, bids: [nodeRow, bad], asks: [] },
      baseUrl: 'http://node.example',
    }))
    const book = await adapter.fetchBook(CHAIN, PAIR)
    expect(book.bids.length).toBe(1)
    expect(book.rawRows).toBe(2)
    expect(book.droppedRows).toBe(1)
  })
})

describe('第 40 轮：asIntString 边界口径（第 38 轮复审 F1/F2，经 toRawOrder 入口）', () => {
  const baseRow = {
    orderId: 'soak_1',
    trader: TRADER,
    pair: PAIR,
    side: 'buy',
    price: '2000000000000000000000',
    filled: '0',
    status: 'open',
    nonce: 0,
    createdAt: 1700000000,
    expiresAt: 1700086400,
    signature: '0xabc',
  }

  const accept: Array<[string, unknown, string]> = [
    ['负数全零小数 "-123.000"', '-123.000', '-123'],
    ['前导零全零小数 "000123.000"', '000123.000', '000123'],
    ['带空白整数串 " 123 "（trim 后接受）', ' 123 ', '123'],
    ['安全整数上限（数字）', Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)],
    ['超安全整数的字符串形式（原样保留，不丢精度）', '9007199254740993', '9007199254740993'],
  ]
  it.each(accept)('%s → 接受', (_name, amount, expected) => {
    const o = toRawOrder({ ...baseRow, amount })
    expect(o).not.toBeNull()
    expect(o!.amount).toBe(expected)
  })

  const reject: Array<[string, unknown]> = [
    ['空小数部分 "123."', '123.'],
    ['正号 "+123"', '+123'],
    ['非零小数字符串 "1.5"', '1.5'],
    ['小数数字 1.5（与字符串同口径拒绝，不静默截断）', 1.5],
    ['超安全整数（数字，已丢精度）', Number.MAX_SAFE_INTEGER + 1],
  ]
  it.each(reject)('%s → 整行判无效', (_name, amount) => {
    expect(toRawOrder({ ...baseRow, amount })).toBeNull()
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

  it('第 35 轮 D4：multicall 钉在取到的区块号，快照按该块归属', async () => {
    const pinnedSeen: bigint[] = []
    let blockNo = 777n
    const transport: ChainTransport = {
      async getLatestBlock() {
        return { number: blockNo, timestamp: 1700001000 }
      },
      async multicall(calls, pinned) {
        pinnedSeen.push(pinned)
        return calls.map((c): StateCallResult => {
          if (c.functionName === 'orderFilledIn') return { status: 'success', result: 0n }
          if (c.functionName === 'orderFilledOut') return { status: 'success', result: 0n }
          if (c.functionName === 'usedNonces') return { status: 'success', result: false }
          if (c.functionName === 'orderLocks')
            return { status: 'success', result: [TRADER, LOCK.token, 100n * E18, 1700086400n] }
          return { status: 'success', result: [TRADER, LOCK.token] }
        })
      },
    }
    const reader = createChainStateReader(() => transport, () => 1700001000)
    const req = [{ digest: '0x' + 'cd'.repeat(32), userAddress: TRADER, nonce: 0 }]
    const s1 = await reader.snapshot(CHAIN, req)
    expect(pinnedSeen).toEqual([777n]) // 读取钉在 777，不许滑到更新的块
    expect(s1.blockNumber).toBe(777n)
    expect(s1.states.size).toBe(1)
    blockNo = 778n
    const s2 = await reader.snapshot(CHAIN, req)
    expect(pinnedSeen).toEqual([777n, 778n]) // 新区块重新钉块读取
    expect(s2.blockNumber).toBe(778n)
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
    // 节点单观察评估照常 VALID；可成交认证在过渡期关闭（SIDE_UNPROVABLE）
    expect(r1.views[0].all[0].validity).toBe('VALID')
    expect(r1.views[0].tradeable.length).toBe(0)

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

describe('第 37 轮：逐单方向证明门禁（能力声明不再是唯一开关）', () => {
  const FUTURE_TYPES = {
    Order: [
      ...ORDER_TYPES.Order,
      { name: 'side', type: 'string' },
    ],
  }

  it('(a) 能力被强制为 true、无逐单证明 → 仍带 SIDE_UNPROVABLE、可成交集仍空', async () => {
    const raw = await signedRaw({ orderId: 'r37a' })
    const prepared = await prepareCandidates(CHAIN, [
      book('node', [raw]),
      book('relay', [raw]),
    ])
    const snap = snapshot(new Map([[digestOf(raw), state()]]))
    const ev = evaluateCandidate(prepared.candidates[0], snap, {
      sideProofAvailable: true,
    })
    expect(ev.validity).toBe('VALID')
    expect(ev.tradableBlockers).toContain('SIDE_UNPROVABLE')
    // orderSideProof 对现行类型集恒 false（无方向成员）
    expect(orderSideProof({ reportedSides: ['buy'] })).toBe(false)
  })

  it('(b) 未来类型集声明 side 成员且签名值与自报相符 → 证明在单元级通过', () => {
    expect(
      orderSideProof({
        reportedSides: ['buy'],
        types: FUTURE_TYPES,
        signedSideValue: 'buy',
      }),
    ).toBe(true)
  })

  it('(c) 方向成员在场但签名值与自报不符 → 证明不成立', () => {
    expect(
      orderSideProof({
        reportedSides: ['buy'],
        types: FUTURE_TYPES,
        signedSideValue: 'sell',
      }),
    ).toBe(false)
    // 任一副本自报与签名值不符同样不成立
    expect(
      orderSideProof({
        reportedSides: ['buy', 'sell'],
        types: FUTURE_TYPES,
        signedSideValue: 'buy',
      }),
    ).toBe(false)
    // 有成员但无签名值 → 不成立
    expect(
      orderSideProof({ reportedSides: ['buy'], types: FUTURE_TYPES }),
    ).toBe(false)
  })
})
