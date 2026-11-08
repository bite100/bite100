/**
 * 第 34 轮（无节点阶段 2）双读基础设施 — 类型定义。
 *
 * 口径（轮次文档 docs/round34-nodeless-stage2-2026-11-08.md 为准）：
 * - 统一订单身份 = (chainId, settlementAddress, digest)；digest 一律由前端
 *   既有 EIP-712 工具本地重算，不信任任一数据源返回的 digest 字段。
 * - 每单归入 VALID / UNKNOWN / INVALID（状态机见 evaluate.ts）；
 *   UNKNOWN 与 CONFLICT 都不进可成交集合，只进诊断数据（fail-closed）。
 */

/** 数据源标识：节点订单簿 / 公告栏中继 */
export type BookSource = 'node' | 'relay'

/**
 * 两源统一后的原始订单行。字段口径与节点/中继的现行 API 合同一致：
 * price/amount/filled 为 1e18 定点 wei 整数字符串（amount = amountIn 总量，
 * filled = 数据源自报的已成交 amountIn，仅作诊断，不作权威剩余量）。
 */
export interface RawOrder {
  orderId: string
  trader: string
  pair: string
  side: 'buy' | 'sell'
  price: string
  amount: string
  filled: string
  /** 数据源自报的生命周期字符串（open/partial/filled/cancelled…），仅诊断 */
  status: string
  nonce: number
  createdAt: number
  expiresAt: number
  signature: string
  execType?: string
}

/** 单个数据源一次拉取的订单簿快照 */
export interface SourceBook {
  source: BookSource
  chainId: number
  pair: string
  bids: RawOrder[]
  asks: RawOrder[]
  /** 分页是否拉完；未拉完的数据不进完整性指标 */
  complete: boolean
  /** 本次拉取完成时刻（ms） */
  fetchedAt: number
}

/** 订单统一身份 */
export interface OrderIdentity {
  chainId: number
  settlement: string
  digest: string
  key: string
}

export type OrderValidity = 'VALID' | 'UNKNOWN' | 'INVALID'

/** 生命周期（链上权威口径推导；UNKNOWN 表示无法判定） */
export type OrderLifecycle =
  | 'OPEN'
  | 'PARTIAL'
  | 'FILLED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'UNKNOWN'

export type LockState = 'locked' | 'unlocked' | 'released' | 'unknown'

/** 链上单订单状态（multicall 批量读回的真实语义，见 chainState.ts） */
export interface ChainOrderState {
  filledIn: bigint
  filledOut: bigint
  nonceUsed: boolean
  /** orderLocks 记录；user 为零地址时为 null（从未落锁或锁已释放/耗尽删除） */
  lock: { user: string; token: string; remaining: bigint; expiresAt: bigint } | null
  /** lockTombstones 记录；user 为零地址时为 null（从未落过锁） */
  tombstone: { user: string; token: string } | null
  /** Settlement.verifyOrderSignature 链上验签结果（仅本地 ecrecover 失败时才查） */
  chainSignatureValid?: boolean
}

/** 一次链上批量读取快照（按区块高度组织） */
export interface ChainSnapshot {
  chainId: number
  blockNumber: bigint
  /** 最新区块 timestamp（秒）——过期判定只用它，不用浏览器时钟 */
  blockTimestamp: number
  /** 区块过旧（墙钟年龄超阈值）：链上口径不可信，相关判定一律 UNKNOWN */
  stale: boolean
  states: Map<string, ChainOrderState>
  /** multicall 部分失败导致状态缺失的 digest 集合 */
  missing: Set<string>
}

/** 状态机评估后的订单（合并视图的一项） */
export interface EvaluatedOrder {
  identity: OrderIdentity
  orderId: string
  pair: string
  side: 'buy' | 'sell'
  trader: string
  /** 本地重算所依据的签名订单字段（OrderData 形态，金额为十进制字符串） */
  amountIn: string
  amountOut: string
  price: string
  timestamp: number
  expiresAt: number
  nonce: number
  sources: BookSource[]
  raw: Partial<Record<BookSource, RawOrder>>
  validity: OrderValidity
  /** 链上状态确实读到（非缺失/非过旧）——指标分母口径用 */
  chainKnown: boolean
  lifecycle: OrderLifecycle
  /** 同 digest 两源未签名业务字段（side/pair/execType）不一致 */
  conflict: boolean
  /** 机器可读判定原因码（诊断用） */
  reasons: string[]
  /** 链上权威剩余量（wei 整数字符串）；链上未知时为按源自报推导的诊断值并以 validity=UNKNOWN 标注 */
  remainingIn: string
  remainingOut: string
  lockState: LockState
  /** 至少一份副本签名验不过（数据质量诊断；不影响已验过的正本判定） */
  badSignatureCopies: number
}

/** 合并视图：tradeable 为可成交集合（仅 VALID 且无冲突），all 为全部评估结果（诊断） */
export interface MergedView {
  chainId: number
  pair: string
  tradeable: EvaluatedOrder[]
  all: EvaluatedOrder[]
  byKey: Map<string, EvaluatedOrder>
}

export function identityKey(chainId: number, settlement: string, digest: string): string {
  return `${chainId}:${settlement.toLowerCase()}:${digest.toLowerCase()}`
}
