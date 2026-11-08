/**
 * 第 34 轮（无节点阶段 2）影子指标 — 口径与轮次文档 §指标一致：
 *
 * - 两源共同单核心字段冲突率 = 共同单中未签名业务字段冲突数 / 共同单数
 * - 同单状态一致率 = 共同单中「无字段冲突 + 两源自报剩余量均与链上一致 +
 *   两源自报状态映射的生命周期与链上推导一致」的单数 / 有链上状态的共同单数
 *   （比较 digest/核心字段/剩余量/生命周期，不只比状态字符串）
 * - 簿差异率（按链/对/方向）= (仅节点有 + 仅公告栏有) / 两源并集，
 *   并分拆 仅节点有 / 仅公告栏有 / 字段冲突 / 数量不同（自报 filled 不同）
 * - 链上无效单比例 = INVALID / (VALID + INVALID)
 * - 单源独有单比例 = 只在一源出现的单 / 全部单
 * - 链上状态未知率 = UNKNOWN / 全部单
 * - 可成交误判率 = 朴素合并（只看源自报状态 open/partial）会展示为可成交、
 *   但链上判定 INVALID 的单 / 朴素可成交集
 * - 订单发现延迟 = 观察器首次在某源见到该单的时刻 − 订单创建时间（纵向
 *   累计样本的中位数；单次快照只能给出年龄，不能代替本口径）
 * - 三源可用率 = 节点 / 公告栏 / RPC 各自独立统计（成功轮次 / 总轮次），
 *   不许平均掩盖
 * - 分页完整度 = 各源最近一轮 complete 标记
 *
 * 未拉完（complete=false）的一源，其「独有/缺失」类计数不可信：
 * 对应簿差异条目以 trustworthy=false 标注，面板展示时须明示。
 */
import type {
  BookSource,
  EvaluatedOrder,
  MergedView,
  OrderLifecycle,
  SourceBook,
} from './types'

export interface Ratio {
  num: number
  den: number
  rate: number | null
}

const ratio = (num: number, den: number): Ratio => ({
  num,
  den,
  rate: den > 0 ? num / den : null,
})

export interface BookSideDiff {
  pair: string
  side: 'buy' | 'sell'
  onlyNode: number
  onlyRelay: number
  conflict: number
  qtyDiff: number
  union: number
  diffRate: Ratio
  /** 两源该轮都拉完才可信 */
  trustworthy: boolean
}

export interface ShadowMetrics {
  totals: { orders: number; common: number; nodeOnly: number; relayOnly: number }
  conflictRateAmongCommon: Ratio
  stateConsistencyRate: Ratio
  bookDiffOverall: Ratio
  bookDiffByPairSide: BookSideDiff[]
  chainInvalidRatio: Ratio
  singleSourceRatio: Ratio
  unknownRatio: Ratio
  falseTradeableRate: Ratio
  discoveryLatencyMs: Record<BookSource, { samples: number; median: number | null }>
  availability: Record<'node' | 'relay' | 'rpc', Ratio>
  paginationComplete: Partial<Record<BookSource, boolean>>
}

export interface RoundInput {
  views: MergedView[]
  books: Array<{ pair: string; node: SourceBook | null; relay: SourceBook | null }>
  chainOk: boolean
  nowMs: number
}

const STATUS_TO_LIFECYCLE: Record<string, OrderLifecycle> = {
  open: 'OPEN',
  partial: 'PARTIAL',
  filled: 'FILLED',
  cancelled: 'CANCELLED',
  canceled: 'CANCELLED',
  expired: 'EXPIRED',
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

/** 纵向观察器：跨轮次累计首次发现时间与三源可用率（内存态，不落盘） */
export class ShadowObserver {
  private firstSeen = new Map<string, Partial<Record<BookSource, number>>>()
  private latencySamples: Record<BookSource, number[]> = { node: [], relay: [] }
  private attempts: Record<'node' | 'relay' | 'rpc', { ok: number; total: number }> = {
    node: { ok: 0, total: 0 },
    relay: { ok: 0, total: 0 },
    rpc: { ok: 0, total: 0 },
  }

  recordAvailability(source: 'node' | 'relay' | 'rpc', ok: boolean): void {
    const a = this.attempts[source]
    a.total += 1
    if (ok) a.ok += 1
  }

  availability(): ShadowMetrics['availability'] {
    return {
      node: ratio(this.attempts.node.ok, this.attempts.node.total),
      relay: ratio(this.attempts.relay.ok, this.attempts.relay.total),
      rpc: ratio(this.attempts.rpc.ok, this.attempts.rpc.total),
    }
  }

  /** 记录一轮评估结果中的首次发现（按统一身份 key） */
  observeOrders(orders: EvaluatedOrder[], nowMs: number): void {
    for (const o of orders) {
      let entry = this.firstSeen.get(o.identity.key)
      if (!entry) {
        entry = {}
        this.firstSeen.set(o.identity.key, entry)
      }
      for (const src of o.sources) {
        if (entry[src] === undefined) {
          entry[src] = nowMs
          const latency = nowMs - o.timestamp * 1000
          if (latency >= 0) this.latencySamples[src].push(latency)
        }
      }
    }
  }

  latency(): ShadowMetrics['discoveryLatencyMs'] {
    return {
      node: { samples: this.latencySamples.node.length, median: median(this.latencySamples.node) },
      relay: { samples: this.latencySamples.relay.length, median: median(this.latencySamples.relay) },
    }
  }
}

/** 一轮影子指标计算（纯函数：纵向部分由 observer 提供） */
export function computeShadowMetrics(
  input: RoundInput,
  observer: ShadowObserver,
): ShadowMetrics {
  const all: EvaluatedOrder[] = input.views.flatMap((v) => v.all)
  const common = all.filter((o) => o.sources.length === 2)
  const nodeOnly = all.filter((o) => o.sources.length === 1 && o.sources[0] === 'node')
  const relayOnly = all.filter((o) => o.sources.length === 1 && o.sources[0] === 'relay')

  const conflicts = common.filter((o) => o.conflict)

  // 同单状态一致率：分母为链上状态确实读到的共同单（含冲突单——冲突正是不一致）
  const chainDecided = common.filter((o) => o.chainKnown)
  const consistent = chainDecided.filter((o) => {
    if (o.conflict) return false
    for (const src of ['node', 'relay'] as const) {
      const raw = o.raw[src]
      if (!raw) return false
      try {
        const implied = BigInt(o.amountIn) - BigInt(raw.filled || '0')
        if (implied.toString() !== o.remainingIn) return false
      } catch {
        return false
      }
      const mapped = STATUS_TO_LIFECYCLE[(raw.status || '').toLowerCase()]
      if (mapped && mapped !== o.lifecycle) return false
    }
    return true
  })

  // 簿差异（按对/方向，从原始书籍重算 digest 集合的差集口径须与评估同键：
  // 这里以评估后的订单集合为准——键即统一身份）
  const byPairSide: BookSideDiff[] = []
  let diffNum = 0
  let diffDen = 0
  for (const { pair } of input.books) {
    for (const side of ['buy', 'sell'] as const) {
      const inPair = all.filter((o) => o.pair === pair)
      // 方向按评估后的规范 side（节点优先）分拆：某源把 side 写反属于
      // 字段冲突（在 conflict 计数），不能误计成「该方向独有单」
      const nodeKeys = new Set(
        inPair.filter((o) => o.side === side && o.raw.node).map((o) => o.identity.key),
      )
      const relayKeys = new Set(
        inPair.filter((o) => o.side === side && o.raw.relay).map((o) => o.identity.key),
      )
      const union = new Set([...nodeKeys, ...relayKeys])
      const onlyNode = [...nodeKeys].filter((k) => !relayKeys.has(k)).length
      const onlyRelay = [...relayKeys].filter((k) => !nodeKeys.has(k)).length
      const both = inPair.filter(
        (o) => nodeKeys.has(o.identity.key) && relayKeys.has(o.identity.key),
      )
      const conflictCount = both.filter((o) => o.conflict).length
      const qtyDiff = both.filter((o) => {
        try {
          return BigInt(o.raw.node?.filled || '0') !== BigInt(o.raw.relay?.filled || '0')
        } catch {
          return true
        }
      }).length
      const bookEntry = input.books.find((b) => b.pair === pair)
      byPairSide.push({
        pair,
        side,
        onlyNode,
        onlyRelay,
        conflict: conflictCount,
        qtyDiff,
        union: union.size,
        diffRate: ratio(onlyNode + onlyRelay, union.size),
        trustworthy: Boolean(bookEntry?.node?.complete && bookEntry?.relay?.complete),
      })
      diffNum += onlyNode + onlyRelay
      diffDen += union.size
    }
  }

  const validCount = all.filter((o) => o.validity === 'VALID').length
  const invalidCount = all.filter((o) => o.validity === 'INVALID').length
  const unknownCount = all.filter((o) => o.validity === 'UNKNOWN').length

  // 朴素可成交集：任一源自报 open/partial 即算（无链上过滤的旧口径）
  const naive = all.filter((o) =>
    Object.values(o.raw).some((r) => {
      const s = (r?.status || '').toLowerCase()
      return s === 'open' || s === 'partial'
    }),
  )
  const falseTradeable = naive.filter((o) => o.validity === 'INVALID')

  const paginationComplete: ShadowMetrics['paginationComplete'] = {}
  for (const b of input.books) {
    if (b.node) paginationComplete.node = (paginationComplete.node ?? true) && b.node.complete
    if (b.relay) paginationComplete.relay = (paginationComplete.relay ?? true) && b.relay.complete
  }

  return {
    totals: {
      orders: all.length,
      common: common.length,
      nodeOnly: nodeOnly.length,
      relayOnly: relayOnly.length,
    },
    conflictRateAmongCommon: ratio(conflicts.length, common.length),
    stateConsistencyRate: ratio(consistent.length, chainDecided.length),
    bookDiffOverall: ratio(diffNum, diffDen),
    bookDiffByPairSide: byPairSide,
    chainInvalidRatio: ratio(invalidCount, validCount + invalidCount),
    singleSourceRatio: ratio(nodeOnly.length + relayOnly.length, all.length),
    unknownRatio: ratio(unknownCount, all.length),
    falseTradeableRate: ratio(falseTradeable.length, naive.length),
    discoveryLatencyMs: observer.latency(),
    availability: observer.availability(),
    paginationComplete,
  }
}
