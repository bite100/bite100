/**
 * 第 34 轮双读 — 候选构建、本地验签与状态机评估（权威顺序，简报定稿口径）。
 *
 * 状态机（每单归入 VALID / UNKNOWN / INVALID，顺序即优先级）：
 * 1. 签名订单重构失败（交易对未知/金额非法）→ INVALID（UNBUILDABLE）
 * 2. 本地验签（ecrecover，既有 verifyOrderSignatureSignedData，关浏览器
 *    时钟过期检查）全部副本未过 → 补链上 verifyOrderSignature（ERC-1271）；
 *    两者皆未过 → INVALID（BAD_SIGNATURE）；链上快照缺失时无法补查 → UNKNOWN
 * 3. 无链上快照 / 区块过旧 / 该单链上状态缺失 → UNKNOWN（fail-closed）
 * 4. 链上时间过期（区块 timestamp > expiresAt）→ INVALID（EXPIRED）
 * 5. 累计成交 filledIn ≥ amountIn → INVALID 口径的终局：FILLED（FULLY_FILLED）
 * 6. nonce 已消费且本单无任何成交 → INVALID（NONCE_CONSUMED，被别的订单占用）
 * 7. 有墓碑、无活跃锁、未全成交 → INVALID（LOCK_RELEASED，锁已释放 = 已撤/失效）
 * 8. 其余 → VALID；无锁无墓碑（公告栏先行、节点尚未落锁）标 lockState=unlocked
 *    仍 VALID（锁由提交者结算前补齐，见 Vault.lockForOrder 无许可口径）。
 * 同 digest 两源未签名业务字段（side / pair / execType）不一致 → conflict，
 * 无论 validity 为何都不进可成交集合（evaluate 输出 validity=UNKNOWN +
 * CONFLICT 原因码，保守口径）。
 */
import { getChainConfig } from '../../config/chains'
import { type OrderData } from '../orderSigningTypes'
import { verifyOrderSignatureSignedData } from '../orderVerification'
import { buildSignedOrderData, computeOrderDigest } from './digest'
import type {
  BookSource,
  ChainSnapshot,
  EvaluatedOrder,
  MergedView,
  OrderIdentity,
  RawOrder,
  SourceBook,
} from './types'
import { identityKey } from './types'

export type VerifyFn = (
  data: OrderData,
  signature: string,
  chainId: number,
) => Promise<boolean>

/** 缺省验签：复用既有实现；checkExpiry=false（过期只按链上区块时间判） */
export const defaultVerifyFn: VerifyFn = async (data, signature, chainId) => {
  if (!signature) return false
  return verifyOrderSignatureSignedData(data, signature, {
    chainId,
    checkExpiry: false,
  })
}

export interface PreparedCandidate {
  identity: OrderIdentity
  data: OrderData
  raws: Partial<Record<BookSource, RawOrder>>
  /** 每份副本的本地验签结果 */
  localVerify: Partial<Record<BookSource, boolean>>
  /** 任一副本本地验签通过 */
  anyLocalValid: boolean
}

export interface PrepareResult {
  candidates: PreparedCandidate[]
  /** 无法重构签名订单的行（直接 INVALID，含兜底身份） */
  unbuildable: EvaluatedOrder[]
}

const ZERO_DIGEST = `0x${'0'.repeat(64)}`

/** 两源书籍 → 候选集合：重构签名订单、本地重算 digest、逐副本本地验签 */
export async function prepareCandidates(
  chainId: number,
  books: Array<SourceBook | null>,
  verify: VerifyFn = defaultVerifyFn,
): Promise<PrepareResult> {
  const cfg = getChainConfig(chainId)
  const settlement = cfg?.contracts.settlement ?? ''
  const byKey = new Map<string, PreparedCandidate>()
  const unbuildable: EvaluatedOrder[] = []
  for (const book of books) {
    if (!book) continue
    for (const raw of [...book.bids, ...book.asks]) {
      const data = buildSignedOrderData(raw, chainId)
      if (!data) {
        unbuildable.push({
          identity: {
            chainId,
            settlement,
            digest: ZERO_DIGEST,
            key: identityKey(chainId, settlement, ZERO_DIGEST) + `:unbuildable:${book.source}:${raw.orderId}`,
          },
          orderId: raw.orderId,
          pair: raw.pair,
          side: raw.side,
          trader: raw.trader,
          amountIn: raw.amount,
          amountOut: '0',
          price: raw.price,
          timestamp: raw.createdAt,
          expiresAt: raw.expiresAt,
          nonce: raw.nonce,
          sources: [book.source],
          raw: { [book.source]: raw },
          validity: 'INVALID',
          chainKnown: false,
          lifecycle: 'UNKNOWN',
          conflict: false,
          reasons: ['UNBUILDABLE'],
          remainingIn: raw.amount,
          remainingOut: '0',
          lockState: 'unknown',
          badSignatureCopies: 0,
        })
        continue
      }
      const digest = computeOrderDigest(data, chainId)
      const key = identityKey(chainId, settlement, digest)
      let cand = byKey.get(key)
      if (!cand) {
        cand = {
          identity: { chainId, settlement, digest, key },
          data,
          raws: {},
          localVerify: {},
          anyLocalValid: false,
        }
        byKey.set(key, cand)
      }
      // 同源同 digest 出现两行（源数据重复）：保留先到的一行，另一行忽略
      if (!cand.raws[book.source]) {
        cand.raws[book.source] = raw
        const ok = await verify(data, raw.signature, chainId)
        cand.localVerify[book.source] = ok
        if (ok) cand.anyLocalValid = true
      }
    }
  }
  return { candidates: [...byKey.values()], unbuildable }
}

/** 未签名业务字段冲突判定（side/pair/execType——这些字段不进 EIP-712 签名） */
export function unsignedFieldConflict(c: PreparedCandidate): boolean {
  const n = c.raws.node
  const r = c.raws.relay
  if (!n || !r) return false
  if (n.side !== r.side) return true
  if (n.pair !== r.pair) return true
  if ((n.execType ?? 'GTC') !== (r.execType ?? 'GTC')) return true
  return false
}

function clampSub(total: string, used: bigint): string {
  const t = BigInt(total)
  const rest = t - used
  return (rest < 0n ? 0n : rest).toString()
}

/** 单候选状态机评估（chain 为 null 表示 RPC 不可用） */
export function evaluateCandidate(
  c: PreparedCandidate,
  chain: ChainSnapshot | null,
): EvaluatedOrder {
  const sources = Object.keys(c.raws) as BookSource[]
  const conflict = unsignedFieldConflict(c)
  const badCopies = sources.filter((s) => c.localVerify[s] === false).length
  const base: EvaluatedOrder = {
    identity: c.identity,
    orderId: c.data.orderId,
    pair: c.raws.node?.pair ?? c.raws.relay?.pair ?? '',
    side: c.raws.node?.side ?? c.raws.relay?.side ?? 'buy',
    trader: c.data.userAddress,
    amountIn: c.data.amountIn,
    amountOut: c.data.amountOut,
    price: c.data.price,
    timestamp: c.data.timestamp,
    expiresAt: c.data.expiresAt,
    nonce: c.data.nonce,
    sources,
    raw: c.raws,
    validity: 'UNKNOWN',
    chainKnown: false,
    lifecycle: 'UNKNOWN',
    conflict,
    reasons: [],
    // 链上未知时的诊断剩余量：按先到源自报 filled 推导（不作权威）
    remainingIn: (() => {
      const first = c.raws.node ?? c.raws.relay
      if (!first) return c.data.amountIn
      try {
        return clampSub(c.data.amountIn, BigInt(first.filled || '0'))
      } catch {
        return c.data.amountIn
      }
    })(),
    remainingOut: c.data.amountOut,
    lockState: 'unknown',
    badSignatureCopies: badCopies,
  }
  const done = (patch: Partial<EvaluatedOrder>): EvaluatedOrder => {
    const merged = { ...base, ...patch }
    if (conflict && merged.validity === 'VALID') {
      merged.validity = 'UNKNOWN'
      merged.reasons = [...merged.reasons, 'CONFLICT_UNSIGNED_FIELDS']
    } else if (conflict) {
      merged.reasons = [...merged.reasons, 'CONFLICT_UNSIGNED_FIELDS']
    }
    return merged
  }

  // 2) 签名权威：本地任一副本通过即成立；全失败时看链上兜底结果（在链状态里）
  const st = chain?.states.get(c.identity.digest.toLowerCase())
  const signatureProven =
    c.anyLocalValid || (st ? st.chainSignatureValid === true : false)
  if (!signatureProven) {
    if (chain && st && st.chainSignatureValid === false) {
      return done({ validity: 'INVALID', chainKnown: true, reasons: ['BAD_SIGNATURE'] })
    }
    if (chain && !c.anyLocalValid && st && st.chainSignatureValid === undefined) {
      // 本地未过且未补查链上（prepare 阶段应已请求）——保守按签名未证
      return done({ validity: 'UNKNOWN', reasons: ['SIGNATURE_UNPROVEN'] })
    }
    if (!chain) {
      // 本地未过 + 无链上兜底可查：可能为 ERC-1271 合约签名者 → UNKNOWN
      // 本地已过的情况不会走到这里（anyLocalValid 已在 signatureProven 处理）
      return done({ validity: 'UNKNOWN', reasons: ['CHAIN_UNAVAILABLE'] })
    }
    if (!st) {
      return done({ validity: 'UNKNOWN', reasons: ['SIGNATURE_UNPROVEN'] })
    }
    return done({ validity: 'INVALID', reasons: ['BAD_SIGNATURE'] })
  }

  // 3) 链上可用性
  if (!chain) return done({ reasons: ['CHAIN_UNAVAILABLE'] })
  if (chain.stale) return done({ reasons: ['CHAIN_STALE'] })
  if (!st) {
    return done({
      reasons: [chain.missing.has(c.identity.digest.toLowerCase()) ? 'CHAIN_STATE_MISSING' : 'CHAIN_STATE_ABSENT'],
    })
  }

  // 链上权威剩余量
  const remainingIn = clampSub(c.data.amountIn, st.filledIn)
  const remainingOut = clampSub(c.data.amountOut, st.filledOut)
  const chainFields = { remainingIn, remainingOut, chainKnown: true }

  // 4) 链上时间过期
  if (chain.blockTimestamp > c.data.expiresAt) {
    return done({
      validity: 'INVALID',
      lifecycle: 'EXPIRED',
      reasons: ['EXPIRED'],
      lockState: st.lock ? 'locked' : st.tombstone ? 'released' : 'unlocked',
      ...chainFields,
    })
  }
  // 5) 已全成交
  if (st.filledIn >= BigInt(c.data.amountIn)) {
    return done({
      validity: 'INVALID',
      lifecycle: 'FILLED',
      reasons: ['FULLY_FILLED'],
      lockState: st.lock ? 'locked' : st.tombstone ? 'released' : 'unlocked',
      ...chainFields,
    })
  }
  // 6) nonce 被别的订单消费
  if (st.nonceUsed && st.filledIn === 0n && st.filledOut === 0n) {
    return done({
      validity: 'INVALID',
      reasons: ['NONCE_CONSUMED'],
      lockState: st.lock ? 'locked' : st.tombstone ? 'released' : 'unlocked',
      ...chainFields,
    })
  }
  // 7) 墓碑存在、无活跃锁、未全成交 → 锁已释放（撤单/失败释放）
  if (st.tombstone && !st.lock) {
    return done({
      validity: 'INVALID',
      lifecycle: 'CANCELLED',
      reasons: ['LOCK_RELEASED'],
      lockState: 'released',
      ...chainFields,
    })
  }
  // 8) VALID
  return done({
    validity: 'VALID',
    lifecycle: st.filledIn > 0n ? 'PARTIAL' : 'OPEN',
    reasons: st.lock ? [] : ['LOCK_MISSING'],
    lockState: st.lock ? 'locked' : 'unlocked',
    ...chainFields,
  })
}

/** 合并：评估全部候选并产出可成交集合（仅 VALID 且无冲突，稳定排序） */
export function mergeBooks(
  chainId: number,
  pair: string,
  prepared: PrepareResult,
  chain: ChainSnapshot | null,
): MergedView {
  const all = [
    ...prepared.candidates.map((c) => evaluateCandidate(c, chain)),
    ...prepared.unbuildable,
  ]
  const byKey = new Map(all.map((o) => [o.identity.key, o]))
  const tradeable = all
    .filter((o) => o.validity === 'VALID' && !o.conflict)
    .sort((a, b) => {
      if (a.side !== b.side) return a.side === 'buy' ? -1 : 1
      const pa = BigInt(a.price)
      const pb = BigInt(b.price)
      if (pa !== pb) {
        const cmp = pa < pb ? -1 : 1
        return a.side === 'buy' ? -cmp : cmp
      }
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
      return a.identity.digest < b.identity.digest ? -1 : 1
    })
  return { chainId, pair, tradeable, all, byKey }
}
