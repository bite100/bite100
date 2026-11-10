/**
 * 第 34 轮建立的隔离测试（原双读：节点/公告栏/RPC 三源 mock）；
 * 第 51 轮（阶段 5 节点退役）按单源改写：订单源只剩公告栏中继，
 * RPC 仍 mock。订单用真实私钥签名（Hardhat 测试账户 #0），验签走
 * 生产代码路径。覆盖：RPC 故障→UNKNOWN、分页截断、部分成交剩余量、
 * 链上时间过期、故障恢复、逐单方向证明、中继簿内同单去重。
 * 逐条改写登记见 docs/round51-stage5-node-retirement-2026-11-09.md。
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
import { createRelayBookAdapter, normalizeBookRows, toRawOrder } from './adapters'
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
import { runBookRound, type BookReadDeps } from './index'
import { orderSideProof } from './sideProof'
import { toMatcherOrders } from '../matching/fromEvaluated'
import { matchTaker } from '../matching/matcher'
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
    side: d.side,
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

function book(rows: RawOrder[], complete = true): SourceBook {
  return {
    source: 'relay',
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

async function prepareOne(raw: RawOrder) {
  const prepared = await prepareCandidates(CHAIN, [book([raw])])
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
      side: 1,
    }
    expect(hashOrderWithDomain(domain, data)).toBe(
      '0xd793d795036c2d1b548120e9e73ea43a608529b4a23f0d3254c263fde391cec0',
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
    const cand = await prepareOne(raw)
    const ev = evaluateCandidate(cand, snapshot(new Map([[digestOf(raw), state()]])))
    expect(ev.validity).toBe('VALID')
    expect(ev.lifecycle).toBe('OPEN')
    expect(ev.remainingIn).toBe((100n * E18).toString())
    expect(ev.lockState).toBe('locked')
  })

  it('部分成交 → VALID/PARTIAL，剩余量按链上累计成交（规范口径）', async () => {
    const raw = await signedRaw()
    const cand = await prepareOne(raw)
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
    const cand = await prepareOne(raw)
    const ev = evaluateCandidate(
      cand,
      snapshot(new Map([[digestOf(raw), state()]]), { blockTimestamp: 1700086401 }),
    )
    expect(ev.validity).toBe('INVALID')
    expect(ev.reasons).toContain('EXPIRED')
  })

  it('全成交 → FILLED 终局，不进可成交集', async () => {
    const raw = await signedRaw()
    const cand = await prepareOne(raw)
    const snap = snapshot(new Map([[digestOf(raw), state({ filledIn: 100n * E18, filledOut: 200n * E18 })]]))
    const ev = evaluateCandidate(cand, snap)
    expect(ev.lifecycle).toBe('FILLED')
    const view = mergeBooks(CHAIN, PAIR, { candidates: [cand], unbuildable: [] }, snap)
    expect(view.tradeable.length).toBe(0)
  })

  it('nonce 被占用且本单无成交 → INVALID/NONCE_CONSUMED', async () => {
    const raw = await signedRaw()
    const cand = await prepareOne(raw)
    const ev = evaluateCandidate(
      cand,
      snapshot(new Map([[digestOf(raw), state({ nonceUsed: true })]])),
    )
    expect(ev.validity).toBe('INVALID')
    expect(ev.reasons).toContain('NONCE_CONSUMED')
  })

  it('墓碑 + 无活跃锁 → INVALID/LOCK_RELEASED（撤单/释放）', async () => {
    const raw = await signedRaw()
    const cand = await prepareOne(raw)
    const ev = evaluateCandidate(
      cand,
      snapshot(new Map([[digestOf(raw), state({ lock: null })]])),
    )
    expect(ev.validity).toBe('INVALID')
    expect(ev.lifecycle).toBe('CANCELLED')
    expect(ev.lockState).toBe('released')
  })

  it('无锁无墓碑 + 单源（公告栏先行）→ VALID/unlocked；阶段 3 起签名方向可证 → 无阻断', async () => {
    // 第 34 轮口径判 VALID/unlocked；第 36 轮起观察与认证分离，观察
    // 判 VALID、认证因方向不可证恒被 SIDE_UNPROVABLE 阻断。阶段 3
    // side 进签名后：本单签名方向（sell）经重构+验签证明成立，
    // tradableBlockers 为空——无锁不再影响认证（落锁与认证本就无关）。
    const raw = await signedRaw()
    const cand = await prepareOne(raw)
    const ev = evaluateCandidate(
      cand,
      snapshot(new Map([[digestOf(raw), state({ lock: null, tombstone: null })]])),
    )
    expect(ev.validity).toBe('VALID')
    expect(ev.reasons).not.toContain('SIDE_UNCORROBORATED')
    expect(ev.lockState).toBe('unlocked')
    expect(ev.tradableBlockers).toEqual([])
  })

  it('单源 + 锁仓义务方向与自报一致 → VALID；认证来自签名证明而非锁（第 36 轮 N1 结论保留）', async () => {
    const raw = await signedRaw() // side=sell，夹具锁 tokenIn(base) → 派生 sell
    const cand = await prepareOne(raw)
    const ev = evaluateCandidate(
      cand,
      snapshot(new Map([[digestOf(raw), state()]])),
    )
    expect(ev.validity).toBe('VALID')
    expect(ev.lockState).toBe('locked')
    // 阶段 3：认证由逐单签名方向证明给出（side 已签名），锁仓一致与否
    // 都不参与认证——本例无阻断是因为证明成立，不是因为锁相符。
    expect(ev.tradableBlockers).toEqual([])
  })

  it('签名伪造（他人私钥冒签）且链上验签未过 → INVALID/BAD_SIGNATURE', async () => {
    const raw = await signedRaw({}, wallet1)
    const cand = await prepareOne(raw)
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
    const cand = await prepareOne(raw)
    expect(cand.anyLocalValid).toBe(false)
    const ev = evaluateCandidate(
      cand,
      snapshot(new Map([[digestOf(raw), state({ chainSignatureValid: true })]])),
    )
    expect(ev.validity).toBe('VALID')
  })

  it('RPC 故障（无快照）→ UNKNOWN；区块过旧 → UNKNOWN；状态缺失 → UNKNOWN', async () => {
    const raw = await signedRaw()
    const cand = await prepareOne(raw)
    expect(evaluateCandidate(cand, null).reasons).toContain('CHAIN_UNAVAILABLE')
    // 第 42 轮：链上未证 ⇒ tradableBlockers 恒含 CHAIN_UNPROVEN（字段本身 fail-closed）
    const noChain = evaluateCandidate(cand, null)
    expect(noChain.validity).toBe('UNKNOWN')
    expect(noChain.chainKnown).toBe(false)
    expect(noChain.tradableBlockers).toContain('CHAIN_UNPROVEN')
    expect(mergeBooks(CHAIN, PAIR, { candidates: [cand], unbuildable: [] }, null).tradeable).toEqual([])
    expect(
      evaluateCandidate(cand, snapshot(new Map([[digestOf(raw), state()]]), { stale: true }))
        .validity,
    ).toBe('UNKNOWN')
    const missingSnap = snapshot(new Map(), { missing: new Set([digestOf(raw)]) })
    const ev = evaluateCandidate(cand, missingSnap)
    expect(ev.validity).toBe('UNKNOWN')
    expect(ev.reasons).toContain('CHAIN_STATE_MISSING')
  })

  it('阶段 3：源改写 side（未重签）→ 改写副本自成候选且验签失败，真单不受影响', async () => {
    // 旧协议下 side 未签名：改写副本与真单同 digest、靠 CONFLICT 剔除。
    // 阶段 3 side 进签名：改写 side 重构出另一个 digest，自成候选，
    // 本地验签必失败（签名绑的是原方向的消息），真单照常可成交。
    const nodeRaw = await signedRaw({ side: 'sell' })
    const relayRaw = { ...nodeRaw, side: 'buy' as const }
    const prepared = await prepareCandidates(CHAIN, [
      book([nodeRaw]),
      book([relayRaw]),
    ])
    expect(prepared.candidates.length).toBe(2)
    const snap = snapshot(new Map([[digestOf(nodeRaw), state()]]))
    const view = mergeBooks(CHAIN, PAIR, prepared, snap)
    expect(view.all.length).toBe(2)
    const good = view.all.find((o) => o.identity.digest === digestOf(nodeRaw))!
    const bad = view.all.find((o) => o.identity.digest !== digestOf(nodeRaw))!
    expect(good.validity).toBe('VALID')
    expect(good.tradableBlockers).toEqual([])
    expect(bad.validity).toBe('UNKNOWN')
    expect(bad.reasons).toContain('SIGNATURE_UNPROVEN')
    expect(view.tradeable.length).toBe(1)
    expect(view.tradeable[0].orderId).toBe(nodeRaw.orderId)
  })

  it('单源在场即按链上状态判 VALID；sources 只记中继（原「软撤单不推断撤销」口径的单源形态）', async () => {
    const raw = await signedRaw()
    const cand = await prepareOne(raw)
    const ev = evaluateCandidate(cand, snapshot(new Map([[digestOf(raw), state()]])))
    expect(ev.validity).toBe('VALID')
    expect(ev.sources).toEqual(['relay'])
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

  it('公告栏分页不完整 → UNKNOWN/SOURCE_INCOMPLETE，不进可成交集', async () => {
    const raw = await signedRaw()
    const { ev, view } = await evalWithBooks([book([raw], false)], raw)
    expect(ev.validity).toBe('UNKNOWN')
    expect(ev.reasons).toContain('SOURCE_INCOMPLETE')
    expect(view.tradeable.length).toBe(0)
  })

  it('下一轮分页恢复完整 → 同单回到 VALID（恢复性）', async () => {
    const raw = await signedRaw()
    const first = await evalWithBooks([book([raw], false)], raw)
    expect(first.ev.validity).toBe('UNKNOWN')
    const second = await evalWithBooks([book([raw], true)], raw)
    expect(second.ev.validity).toBe('VALID')
  })
})

describe('阶段 3：方向进签名后的 N1/N3 场景（篡改必露馅、证明逐单放行）', () => {
  it('(a) 两源同写被改的 side → 改写改变 digest、验签失败 → UNKNOWN/SIGNATURE_UNPROVEN，不可成交', async () => {
    // N3 场景的阶段 3 结局：旧协议下两源一致地改写 side 无痕（观察
    // VALID、仅认证关闭）；side 进签名后，改写副本重构出的 digest 与
    // 签名对不上，两源同写也救不回来——验签先行失败。
    const raw = await signedRaw({ side: 'sell' })
    const flipped = { ...raw, side: 'buy' as const }
    const prepared = await prepareCandidates(CHAIN, [
      book([flipped]),
      book([flipped]),
    ])
    expect(prepared.candidates.length).toBe(1) // 改写副本彼此一致、同 digest（同源去重后一份）
    expect(prepared.candidates[0].anyLocalValid).toBe(false)
    const snap = snapshot(
      new Map([[digestOf(flipped), state({ lock: null, tombstone: null })]]),
    )
    const ev = evaluateCandidate(prepared.candidates[0], snap)
    expect(ev.conflict).toBe(false) // 两源彼此一致，冲突检查抓不到——但验签抓得到
    expect(ev.validity).toBe('UNKNOWN')
    expect(ev.reasons).toContain('SIGNATURE_UNPROVEN')
    expect(mergeBooks(CHAIN, PAIR, prepared, snap).tradeable.length).toBe(0)
  })

  it('(b) 改写 side + 伪造的「相符」落锁 → 签名门先行拦截，锁旗标不参与判定', async () => {
    // N1 场景的阶段 3 结局：旧协议下攻击者可按自选方向落锁冒充方向
    // 佐证；阶段 3 落锁方向由 Vault 从签名派生、伪造无从下手，且本单
    // 在签名门就被拦下（链上无此 digest 的验签背书），到不了锁比对。
    const raw = await signedRaw({ side: 'sell' })
    const flipped = { ...raw, side: 'buy' as const }
    const prepared = await prepareCandidates(CHAIN, [
      book([flipped]),
      book([flipped]),
    ])
    const buyObligationLock = { ...LOCK, token: PAIR_TOKENS.quote }
    const snap = snapshot(
      new Map([[digestOf(flipped), state({ lock: buyObligationLock })]]),
    )
    const ev = evaluateCandidate(prepared.candidates[0], snap)
    expect(ev.validity).toBe('UNKNOWN')
    expect(ev.reasons).toContain('SIGNATURE_UNPROVEN')
    expect(ev.reasons).not.toContain('SIDE_LOCK_MISMATCH') // 签名门先行返回
    expect(mergeBooks(CHAIN, PAIR, prepared, snap).tradeable.length).toBe(0)
  })

  it('(c) 中继簿内正常单（含声称 market）→ 观察全 VALID，逐单证明放行进可成交集', async () => {
    const plain = await signedRaw({ orderId: 'r36plain' })
    const mkt = await signedRaw({ orderId: 'r36mkt', execType: 'market' })
    const prepared = await prepareCandidates(CHAIN, [
      book([plain, mkt]),
      book([plain, mkt]),
    ])
    const snap = snapshot(
      new Map([
        [digestOf(plain), state()],
        [digestOf(mkt), state()],
      ]),
    )
    const view = mergeBooks(CHAIN, PAIR, prepared, snap)
    expect(view.all.every((o) => o.validity === 'VALID')).toBe(true)
    expect(view.tradeable.length).toBe(2) // 阶段 3：证明成立即放行
    expect(view.all.every((o) => o.tradableBlockers.length === 0)).toBe(true)
  })

  it('(d) 签名方向与链上落锁代币不符（快照/簿不一致）→ 观察旗标 SIDE_LOCK_MISMATCH，validity 与认证不动', async () => {
    // 阶段 3 后锁由 Vault 从签名 side 派生，真实世界里此旗标只可能
    // 来自链上快照过期或簿数据不一致；夹具直接构造不一致快照验证
    // 旗标语义不变：只记观察信号，不降级、不阻断（认证只认签名证明）。
    const raw = await signedRaw({ side: 'sell' }) // 签名 sell → 付款侧 tokenIn(base)
    const cand = await prepareOne(raw)
    const snap = snapshot(
      new Map([[digestOf(raw), state({ lock: { ...LOCK, token: PAIR_TOKENS.quote } })]]),
    )
    const ev = evaluateCandidate(cand, snap)
    expect(ev.validity).toBe('VALID')
    expect(ev.reasons).toContain('SIDE_LOCK_MISMATCH')
    expect(ev.tradableBlockers).toEqual([])
    expect(mergeBooks(CHAIN, PAIR, { candidates: [cand], unbuildable: [] }, snap).tradeable.length).toBe(1)
  })

  it('单源声称市价单（execType=market）→ 观察 VALID（第 36 轮起不再 EXEC_TYPE_UNPROVEN 降级）', async () => {
    const raw = await signedRaw({ execType: 'market' })
    const cand = await prepareOne(raw)
    const ev = evaluateCandidate(
      cand,
      snapshot(new Map([[digestOf(raw), state()]])),
    )
    expect(ev.validity).toBe('VALID')
    expect(ev.reasons).not.toContain('EXEC_TYPE_UNPROVEN')
    expect(ev.tradableBlockers).toEqual([]) // 阶段 3：方向证明成立
  })

  it('同单在中继簿内重复出现（副本 execType 写法不同）→ 同源去重只留先到一份，仍 VALID', async () => {
    // 原双源断言「两源 execType 写法不同不算冲突」随冲突判定一并退役；
    // 单源等价行为是 prepareCandidates 的同源同 digest 去重：第二份
    // 副本被忽略，候选只有一份、按先到副本评估（第 51 轮登记改写）。
    const raw = await signedRaw()
    const withLimit = { ...raw, execType: 'limit' }
    const prepared = await prepareCandidates(CHAIN, [book([raw, withLimit])])
    expect(prepared.candidates.length).toBe(1)
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

describe('第 51 轮块 3 根因修复：中继适配器缺省 fetch 显式超时', () => {
  it('对端永不响应 → 在截止期内失败（不再无界等待）', async () => {
    const originalFetch = globalThis.fetch
    // 对端永不返回响应，只在 abort 信号到达时才 reject（真实 fetch 的语义）
    globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted', 'AbortError')),
        )
      })) as typeof fetch
    try {
      const adapter = createRelayBookAdapter('https://relay.example', undefined, {
        timeoutMs: 50,
      })
      const started = Date.now()
      await expect(adapter.fetchBook(CHAIN, PAIR)).rejects.toThrow()
      expect(Date.now() - started).toBeLessThan(5000)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('注入 fetchFn 的路径不受缺省超时影响（调用方自带超时纪律）', async () => {
    const adapter = createRelayBookAdapter('https://relay.example', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ bids: [], asks: [] }),
    }))
    const res = await adapter.fetchBook(CHAIN, PAIR)
    expect(res.bids).toEqual([])
    expect(res.complete).toBe(true)
  })
})

describe('第 52 轮 A1：中继适配器交易对隔离', () => {
  const row = (orderId: string, pair: string, side: 'buy' | 'sell') => ({
    orderId,
    trader: TRADER,
    pair,
    side,
    price: '1000000000000000000',
    amount: '1000000000000000000',
    filled: '0',
    status: 'open',
    nonce: 0,
    createdAt: 1700000000,
    expiresAt: 1700086400,
    signature: '0xabc',
  })

  it('混入他对行 → 丢弃且 pairMismatchRows 单独计数，本对行保留', async () => {
    const adapter = createRelayBookAdapter('https://relay.example', async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        pair: PAIR,
        bids: [row('mine', PAIR, 'buy'), row('foreign-bid', 'ETH/USDT', 'buy')],
        asks: [row('foreign-ask', 'TKA/TKB', 'sell')],
      }),
    }))
    const book = await adapter.fetchBook(CHAIN, PAIR)
    expect(book.bids.map((o) => o.orderId)).toEqual(['mine'])
    expect(book.asks).toEqual([])
    expect(book.pairMismatchRows).toBe(2)
    // 与规范化丢弃分开计数：本例三行字段都完整，droppedRows 必须为 0
    expect(book.droppedRows).toBe(0)
    expect(book.rawRows).toBe(3)
  })

  it('全部行属本对 → pairMismatchRows=0，簿面不受影响', async () => {
    const adapter = createRelayBookAdapter('https://relay.example', async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        pair: PAIR,
        bids: [row('b1', PAIR, 'buy')],
        asks: [row('a1', PAIR, 'sell')],
      }),
    }))
    const book = await adapter.fetchBook(CHAIN, PAIR)
    expect(book.pairMismatchRows).toBe(0)
    expect(book.bids.length).toBe(1)
    expect(book.asks.length).toBe(1)
  })
})

describe('第 52 轮 A2：缺省 fetch 超时覆盖响应体', () => {
  it('响应头立即返回但响应体永不结束 → 在截止期内失败', async () => {
    const originalFetch = globalThis.fetch
    // 头（ok/status）立即 resolve；body 读取（json）只在 abort 时才 reject
    globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted', 'AbortError')),
            )
          }),
      })) as unknown as typeof fetch
    try {
      const adapter = createRelayBookAdapter('https://relay.example', undefined, {
        timeoutMs: 50,
      })
      const started = Date.now()
      await expect(adapter.fetchBook(CHAIN, PAIR)).rejects.toThrow()
      expect(Date.now() - started).toBeLessThan(5000)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('响应头与响应体都正常 → 计时不影响正常读取', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ pair: PAIR, bids: [], asks: [] }),
    })) as unknown as typeof fetch
    try {
      const adapter = createRelayBookAdapter('https://relay.example', undefined, {
        timeoutMs: 5000,
      })
      const book = await adapter.fetchBook(CHAIN, PAIR)
      expect(book.bids).toEqual([])
      expect(book.complete).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
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

  it('normalizeBookRows 计数丢弃；中继适配器 SourceBook 带 rawRows/droppedRows（原节点适配器用例的等价改写）', async () => {
    const bad = { ...nodeRow, orderId: 'bad', amount: '1.5' }
    const { orders, droppedRows } = normalizeBookRows([nodeRow, bad])
    expect(orders.length).toBe(1)
    expect(droppedRows).toBe(1)

    const adapter = createRelayBookAdapter('https://relay.example', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ pair: PAIR, bids: [nodeRow, bad], asks: [] }),
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

describe('第 40 轮：响应形态校验（第 38 轮复审 F3；第 51 轮改由中继适配器承载，requireBookSides 口径不变）', () => {
  const adapterWith = (data: unknown) =>
    createRelayBookAdapter('https://relay.example', async () => ({
      ok: true,
      status: 200,
      json: async () => data,
    }))

  it('bids 存在但不是数组 → 抛错（按源错误处理），不静默当空簿', async () => {
    await expect(
      adapterWith({ pair: PAIR, bids: 'oops', asks: [] }).fetchBook(CHAIN, PAIR),
    ).rejects.toThrow(/bids is not an array/)
  })

  it('asks 存在但不是数组 → 抛错', async () => {
    await expect(
      adapterWith({ pair: PAIR, bids: [], asks: { nope: true } }).fetchBook(CHAIN, PAIR),
    ).rejects.toThrow(/asks is not an array/)
  })

  it('响应不是对象 → 抛错', async () => {
    await expect(adapterWith(null).fetchBook(CHAIN, PAIR)).rejects.toThrow(/not an object/)
    await expect(adapterWith('oops').fetchBook(CHAIN, PAIR)).rejects.toThrow(/not an object/)
  })

  it('bids/asks 缺失 → 按空盘口（正常空簿，不抛错）', async () => {
    const book = await adapterWith({ pair: PAIR }).fetchBook(CHAIN, PAIR)
    expect(book.bids).toEqual([])
    expect(book.asks).toEqual([])
    expect(book.rawRows).toBe(0)
    expect(book.droppedRows).toBe(0)
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
          if (c.functionName === 'nonceBitmap') return { status: 'success', result: 0n }
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
      { status: 'success', result: 0n }, // nonceBitmap 字（第 62 轮位图口径）
      { status: 'success', result: [TRADER, LOCK.token, 0n, 0n] },
      { status: 'success', result: [TRADER, LOCK.token] },
    ])
    expect(assembled).toBeNull()
  })

  it('第 62 轮：nonceBitmap 字按 bitPos 位测试得出 nonceUsed', () => {
    const results: StateCallResult[] = [
      { status: 'success', result: 0n },
      { status: 'success', result: 0n },
      { status: 'success', result: 1n << 5n }, // word 0 的 bit 5 已置位
      { status: 'success', result: [TRADER, LOCK.token, 0n, 0n] },
      { status: 'success', result: ['0x0000000000000000000000000000000000000000', LOCK.token] },
    ]
    expect(assembleChainState(results, 5)?.nonceUsed).toBe(true)
    expect(assembleChainState(results, 4)?.nonceUsed).toBe(false)
    expect(assembleChainState(results, 0)?.nonceUsed).toBe(false)
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
          if (c.functionName === 'nonceBitmap') return { status: 'success', result: 0n }
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

describe('编排与故障恢复（第 51 轮：中继单源 runBookRound）', () => {
  function depsWith(opts: {
    relayFails?: boolean
    rpcFails?: boolean
    rows: RawOrder[]
  }): BookReadDeps {
    const relayAdapter: BookAdapter = {
      async fetchBook(chainId, pair) {
        if (opts.relayFails) throw new Error('relay down')
        return { ...book(opts.rows), chainId, pair }
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
    return { relayAdapter, chainReader }
  }

  it('中继故障 → 该轮簿为空 + errors.relay 记录；下一轮恢复后同单 VALID 进可成交集', async () => {
    const raw = await signedRaw({ orderId: 'fr1' })
    const r1 = await runBookRound(depsWith({ rows: [raw], relayFails: true }), CHAIN, [PAIR])
    expect(r1.errors.relay).toContain('relay down')
    expect(r1.books[0].relay).toBeNull()
    expect(r1.views[0].all).toEqual([])
    expect(r1.views[0].tradeable).toEqual([])

    const r2 = await runBookRound(depsWith({ rows: [raw] }), CHAIN, [PAIR])
    expect(r2.errors.relay).toBeUndefined()
    expect(r2.views[0].all[0].validity).toBe('VALID')
    expect(r2.views[0].all[0].sources).toEqual(['relay'])
    expect(r2.views[0].tradeable.length).toBe(1)
  })

  it('RPC 故障 → 全部 UNKNOWN、不进可成交集、errors.rpc 记录', async () => {
    const raw = await signedRaw({ orderId: 'fr2' })
    const round = await runBookRound(depsWith({ rows: [raw], rpcFails: true }), CHAIN, [PAIR])
    expect(round.chainOk).toBe(false)
    expect(round.errors.rpc).toContain('rpc down')
    expect(round.views[0].all[0].validity).toBe('UNKNOWN')
    expect(round.views[0].tradeable.length).toBe(0)
  })
})

describe('逐单方向证明门禁（第 37 轮建立，阶段 3 定版）', () => {
  // 旧协议类型集夹具：阶段 3 之前的 Order 结构（无 side 成员）。
  // 锁死回归：仅有能力声明、没有签名方向成员时证明恒不成立。
  const LEGACY_TYPES = {
    Order: ORDER_TYPES.Order.filter((f) => f.name !== 'side'),
  }

  it('(a) 旧协议类型集（无 side 成员）→ 证明恒不成立，能力声明单独改 true 也放行不了', async () => {
    expect(
      orderSideProof({
        reportedSides: ['sell'],
        types: LEGACY_TYPES,
        signedSideValue: 1,
      }),
    ).toBe(false)
    // 端到端：强制能力为 true 但注入旧类型集证明输入 → 仍阻断
    const raw = await signedRaw({ orderId: 'r37a' })
    const prepared = await prepareCandidates(CHAIN, [
      book([raw]),
      book([raw]),
    ])
    const snap = snapshot(new Map([[digestOf(raw), state()]]))
    const ev = evaluateCandidate(prepared.candidates[0], snap, {
      sideProofAvailable: true,
      sideProofInput: {
        reportedSides: ['sell'],
        types: LEGACY_TYPES,
        signedSideValue: 1,
      },
    })
    expect(ev.validity).toBe('VALID')
    expect(ev.tradableBlockers).toContain('SIDE_UNPROVABLE')
  })

  it('(b) 现行类型集（含 side 成员）+ 签名值与自报相符 → 证明成立', () => {
    expect(
      orderSideProof({ reportedSides: ['sell'], signedSideValue: 1 }),
    ).toBe(true)
    expect(
      orderSideProof({ reportedSides: ['buy'], signedSideValue: 0 }),
    ).toBe(true)
    // 字符串别名形态兼容
    expect(
      orderSideProof({ reportedSides: ['sell'], signedSideValue: '1' }),
    ).toBe(true)
  })

  it('(c) 签名值与自报不符 / 任一副本不符 / 无签名值 → 证明不成立', () => {
    expect(
      orderSideProof({ reportedSides: ['buy'], signedSideValue: 1 }),
    ).toBe(false)
    expect(
      orderSideProof({ reportedSides: ['buy', 'sell'], signedSideValue: 0 }),
    ).toBe(false)
    expect(orderSideProof({ reportedSides: ['buy'] })).toBe(false)
    expect(
      orderSideProof({ reportedSides: [], signedSideValue: 0 }),
    ).toBe(false)
  })

  it('(d) 能力声明被关（opts 强制 false）→ 证明成立也仍阻断（双条件缺一不可）', async () => {
    const raw = await signedRaw({ orderId: 'r37d' })
    const cand = await prepareOne(raw)
    const snap = snapshot(new Map([[digestOf(raw), state()]]))
    const ev = evaluateCandidate(cand, snap, { sideProofAvailable: false })
    expect(ev.validity).toBe('VALID')
    expect(ev.tradableBlockers).toContain('SIDE_UNPROVABLE')
  })

  it('(e) 缺省路径（生产常量）：签名订单逐单证明成立 → 无阻断、进可成交集', async () => {
    const raw = await signedRaw({ orderId: 'r37e' })
    const prepared = await prepareCandidates(CHAIN, [
      book([raw]),
      book([raw]),
    ])
    const snap = snapshot(new Map([[digestOf(raw), state()]]))
    const view = mergeBooks(CHAIN, PAIR, prepared, snap)
    expect(view.tradeable.length).toBe(1)
    expect(view.tradeable[0].tradableBlockers).toEqual([])
  })
})

describe('第 40 轮复审骑乘（阶段 3 并入）：负零口径与顶层数组拒绝', () => {
  const baseRow = {
    orderId: 'r40x',
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

  it('负零：数字 -0 与字符串 "-0" 两路同口径输出 "0"', () => {
    expect(toRawOrder({ ...baseRow, amount: -0 })!.amount).toBe('0')
    expect(toRawOrder({ ...baseRow, amount: '-0' })!.amount).toBe('0')
  })

  it('负零：定点分支 "-0.000…" 整数部分同样规范化为 "0"；"-0.5" 仍拒绝', () => {
    expect(
      toRawOrder({ ...baseRow, amount: '-0.000000000000000000' })!.amount,
    ).toBe('0')
    expect(toRawOrder({ ...baseRow, amount: '-0.5' })).toBeNull()
  })

  it('顶层数组响应 → 中继适配器抛错按源错误处理（不静默当空簿）', async () => {
    const relayAdapter = createRelayBookAdapter('https://relay.example', async () => ({
      ok: true,
      status: 200,
      json: async () => [],
    }))
    await expect(relayAdapter.fetchBook(CHAIN, PAIR)).rejects.toThrow(/top-level array/)
  })
})

describe('第 42 轮：chain-unknown 阻断口径（窗口 1 遗留裁定）', () => {
  it('不可重构订单恒带 CHAIN_UNPROVEN 阻断、永不进可成交集', async () => {
    const raw = await signedRaw()
    raw.pair = 'XXX/USDT' // 未知交易对 → buildSignedOrderData 失败 → unbuildable
    const prepared = await prepareCandidates(CHAIN, [book([raw])])
    expect(prepared.candidates).toEqual([])
    expect(prepared.unbuildable).toHaveLength(1)
    const u = prepared.unbuildable[0]
    expect(u.chainKnown).toBe(false)
    expect(u.tradableBlockers).toContain('CHAIN_UNPROVEN')
    expect(mergeBooks(CHAIN, PAIR, prepared, null).tradeable).toEqual([])
  })

  it('链上已证的 VALID 单不带 CHAIN_UNPROVEN（口径不误伤正常放行）', async () => {
    const raw = await signedRaw()
    const cand = await prepareOne(raw)
    const ev = evaluateCandidate(
      cand,
      snapshot(new Map([[digestOf(raw), state()]])),
    )
    expect(ev.chainKnown).toBe(true)
    expect(ev.tradableBlockers).not.toContain('CHAIN_UNPROVEN')
  })
})

describe('第 46 轮 P1（第 51 轮单源改写）：同单在中继簿内重复出现 → 合并+撮合只消费一次', () => {
  it('同一签名订单在中继簿里出现两行（同 digest）→ 候选/可成交/撮合输入各只有一份，撮合只成交一次', async () => {
    // 原双源形态（同单同时在节点簿与中继簿）随节点退役消失；单源下
    // 同一风险的等价形态是中继簿内部重复行（重广播/镜像回灌都可能
    // 造成）——prepareCandidates 的同源同 digest 去重是唯一防线。
    const raw = await signedRaw()
    const prepared = await prepareCandidates(CHAIN, [book([raw, { ...raw }])])
    expect(prepared.candidates.length).toBe(1)
    const view = mergeBooks(
      CHAIN,
      PAIR,
      prepared,
      snapshot(new Map([[digestOf(raw), state()]])),
    )
    expect(view.tradeable.length).toBe(1)
    expect(view.tradeable[0].sources).toEqual(['relay'])
    // 撮合输入层同样只有一份
    const makers = toMatcherOrders(view.tradeable)
    expect(makers.length).toBe(1)
    // 撮合消费：买方 taker 想吃 150 Token0（超过该单余量 100）——若同单
    // 被复制成两份，会成交两腿共 150；只消费一次则一腿封顶 100。
    const result = matchTaker(
      {
        trader: wallet1.address,
        side: 'buy',
        priceWei: 2n * E18,
        amountToken0: 150n * E18,
      },
      makers,
    )
    expect(result.legs.length).toBe(1)
    expect(result.legs[0].makerOrderId).toBe(raw.orderId)
    expect(result.filledToken0).toBe(100n * E18)
    expect(result.remainderToken0).toBe(50n * E18)
  })

  it('负控（第 48 轮）：人为让去重失效（同单复制两份喂撮合）→ 两腿吃满 150，证明上一条断言有牙', async () => {
    // 负控口径：P1 断言若想证明「去重真的在起作用」，必须展示去重
    // 一旦失效、同样的输入会产生断言禁止的结果。matcher 本身不按
    // orderId 去重（它只按输入数组逐份消费），所以把合并层的输出
    // 人为复制一份再喂进去，就精确模拟了「合并层去重失效」。
    const raw = await signedRaw()
    const prepared = await prepareCandidates(CHAIN, [book([raw])])
    const view = mergeBooks(
      CHAIN,
      PAIR,
      prepared,
      snapshot(new Map([[digestOf(raw), state()]])),
    )
    const makers = toMatcherOrders(view.tradeable)
    expect(makers.length).toBe(1)
    const doubled = [...makers, ...makers]
    const result = matchTaker(
      {
        trader: wallet1.address,
        side: 'buy',
        priceWei: 2n * E18,
        amountToken0: 150n * E18,
      },
      doubled,
    )
    // 与 P1 断言正好相反：两腿、吃满 150——P1 的「一腿封顶 100」
    // 在去重失效时必然变红，断言不是恒真摆设。
    expect(result.legs.length).toBe(2)
    expect(result.filledToken0).toBe(150n * E18)
    expect(result.remainderToken0).toBe(0n)
  })
})
