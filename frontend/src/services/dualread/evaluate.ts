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
 *
 * 第 35 轮加固（ChatGPT 复审 D1/D2）：
 * - D1 分页完整度：候选记录每个来源的 SourceBook.complete；仅被不完整
 *   来源证明的订单（无任一完整来源在场）→ UNKNOWN（SOURCE_INCOMPLETE），
 *   不进可成交集；有完整来源在场时按完整来源的数据判定（展示字段亦优先
 *   取完整来源）。轮次文档原口径：分页未拉完 ⇒ 该源订单按未知处理。
 * - D2 未签名字段可信边界：side 不在签名结构内（tokenIn/tokenOut 恒为
 *   交易对 Token0/Token1、与方向无关，三方实现一致），无法从签名字段
 *   推导；但 Vault 锁仓代币是链上方向证据——卖单锁 tokenIn、买单锁
 *   tokenOut（node/internal/settlement/lock.go ObligationForOrder）。
 *   据此：任一来源自报 side 与锁仓派生方向不符 → SIDE_LOCK_MISMATCH；
 *   单源订单无锁仓佐证时方向无从证明 → SIDE_UNCORROBORATED；单源订单
 *   声称 execType=market（非缺省执行类型，同样未签名）→ EXEC_TYPE_UNPROVEN。
 *   以上任一命中都只把 VALID 降为 UNKNOWN（不改 INVALID 终局判定）。
 */
import { getChainConfig } from '../../config/chains'
import { type OrderData } from '../orderSigningTypes'
import { verifyOrderSignatureSignedData } from '../orderVerification'
import { buildSignedOrderData, computeOrderDigest } from './digest'
import type {
  BookSource,
  ChainOrderState,
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
  /** 第 35 轮 D1：每个来源本轮书籍的分页完整度（SourceBook.complete） */
  complete: Partial<Record<BookSource, boolean>>
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
          complete: {},
        }
        byKey.set(key, cand)
      }
      // 同源同 digest 出现两行（源数据重复）：保留先到的一行，另一行忽略
      if (!cand.raws[book.source]) {
        cand.raws[book.source] = raw
        cand.complete[book.source] = book.complete
        const ok = await verify(data, raw.signature, chainId)
        cand.localVerify[book.source] = ok
        if (ok) cand.anyLocalValid = true
      }
    }
  }
  return { candidates: [...byKey.values()], unbuildable }
}

/**
 * execType 归一化：缺失/空/'limit' 都是协议缺省的限价语义（第 17 轮：
 * 市价单靠未签名的 execType:'market' 标记，其余皆限价）；relay/orders.ts
 * 的合法取值域只有 limit/market。旧冲突判定把缺失映射成 'GTC'，会把
 * 「一源写 limit、一源不写」误判冲突——按缺省语义归一后才对。
 */
export function normalizeExecType(x?: string): string {
  const v = (x ?? '').trim().toLowerCase()
  return v === '' || v === 'limit' ? 'limit' : v
}

/** 未签名业务字段冲突判定（side/pair/execType——这些字段不进 EIP-712 签名） */
export function unsignedFieldConflict(c: PreparedCandidate): boolean {
  const n = c.raws.node
  const r = c.raws.relay
  if (!n || !r) return false
  if (n.side !== r.side) return true
  if (n.pair !== r.pair) return true
  if (normalizeExecType(n.execType) !== normalizeExecType(r.execType)) return true
  return false
}

/**
 * 第 35 轮 D2：从 Vault 链上锁仓派生订单方向。
 * 签名结构的方向无关性是协议事实（tokenIn/tokenOut 恒为交易对
 * Token0/Token1），但落锁义务按方向分化：卖单锁 tokenIn×amountIn、
 * 买单锁 tokenOut×amountOut（node/internal/settlement/lock.go 的
 * ObligationForOrder；Vault.lockForOrder 验签后按 order 本身派生锁量，
 * 锁定代币不是节点可任意填写的字段）。故活跃锁的 token 即方向的链上
 * 证据：== tokenIn → sell；== tokenOut → buy；无锁/锁代币不在对内 → null
 * （方向无从证明）。墓碑不作证据：锁释放后方向只剩来源自报。
 */
export function deriveSideFromLock(
  data: OrderData,
  st: ChainOrderState | undefined,
): 'buy' | 'sell' | null {
  const token = st?.lock?.token?.toLowerCase()
  if (!token) return null
  if (token === data.tokenIn.toLowerCase()) return 'sell'
  if (token === data.tokenOut.toLowerCase()) return 'buy'
  return null
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
  // D1：有任一完整来源在场才算数据完整；展示/诊断字段优先取完整来源
  const incompleteOnly = sources.length > 0 && !sources.some((s) => c.complete[s])
  const primaryRaw =
    (c.raws.node && c.complete.node ? c.raws.node : undefined) ??
    (c.raws.relay && c.complete.relay ? c.raws.relay : undefined) ??
    c.raws.node ??
    c.raws.relay
  const base: EvaluatedOrder = {
    identity: c.identity,
    orderId: c.data.orderId,
    pair: primaryRaw?.pair ?? '',
    side: primaryRaw?.side ?? 'buy',
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
      const first = primaryRaw
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
  // D2 信任标志（st 可用后赋值；done 只在把 VALID 降级时消费它们）
  let sideMismatch = false
  let sideUncorroborated = false
  let execUnproven = false
  const done = (patch: Partial<EvaluatedOrder>): EvaluatedOrder => {
    const merged = { ...base, ...patch }
    if (conflict) {
      merged.reasons = [...merged.reasons, 'CONFLICT_UNSIGNED_FIELDS']
    }
    if (merged.validity === 'VALID') {
      // D1/D2 上限：字段冲突、仅不完整来源证明、方向与锁仓证据不符、
      // 单源方向无佐证、单源非缺省 execType 无从证明——任一命中，
      // 「有效」结论都不可信，降为 UNKNOWN（不进可成交集）。
      const caps: string[] = []
      if (incompleteOnly) caps.push('SOURCE_INCOMPLETE')
      if (sideMismatch) caps.push('SIDE_LOCK_MISMATCH')
      else if (sideUncorroborated) caps.push('SIDE_UNCORROBORATED')
      if (execUnproven) caps.push('EXEC_TYPE_UNPROVEN')
      if (conflict || caps.length > 0) {
        merged.validity = 'UNKNOWN'
        merged.reasons = [...merged.reasons, ...caps]
      }
    }
    return merged
  }

  // 2) 签名权威：本地任一副本通过即成立；全失败时看链上兜底结果（在链状态里）
  const st = chain?.states.get(c.identity.digest.toLowerCase())
  // D2：锁仓派生方向与来源自报方向的核对（链上状态在场时才有证据）
  const derivedSide = deriveSideFromLock(c.data, st)
  if (derivedSide && sources.some((s) => c.raws[s]!.side !== derivedSide)) {
    sideMismatch = true
  }
  if (sources.length === 1) {
    const sole = c.raws[sources[0]]!
    if (!derivedSide) sideUncorroborated = true
    if (normalizeExecType(sole.execType) !== 'limit') execUnproven = true
  }
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
