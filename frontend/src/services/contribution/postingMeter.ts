/**
 * 盘口挂单计量（第 42 轮 块 B）：挂单线（定版权重 35，四线第一位）的
 * 「挂单时长 × 深度」积分——纯函数统计层，不新建任何索引设施。
 *
 * 数据来源（全部骑乘既有设施，见 docs/round42-weights-gas-vault-2026-11-08.md）：
 * - 中继 D1 `orders` 表（relay/migrations/0001_init.sql）：user_address、
 *   amount（amountIn，wei 字符串）、price（wei 字符串）、created_at
 *   （= 签名 timestamp）、expires_at、status、filled；
 * - Envio 索引器 Trade / GasShare 实体（indexer/schema.graphql）：成交按
 *   digest 关联（digestAssociated），blockTimestamp 给出成交时刻——订单
 *   被全量成交的时刻即其「关闭」时刻；
 * - 节点订单簿 /api/orderbook 只是当下快照，无历史，仅作在场校验，不作
 *   计量输入。
 *
 * 生命周期口径（每个订单一段 [createdAt, endAt)）：
 * - endAt = min(全量成交时刻（索引器）, expiresAt, 周期结束时刻)；
 *   撤单在链下无权威事件（锁墓碑只证明锁释放、无订单级时间源），本轮
 *   口径以 expiresAt 为上界——撤单后仍计到过期的部分是已知高估项，
 *   在轮文档里明示，后续轮可用 Vault 锁墓碑快照收紧；
 * - 只计周期窗口 [periodStart, periodEnd) 内的交叠时长；
 * - 部分成交：本轮按整单深度计满时长（filled 字段在中继侧是消息自报、
 *   非权威），按剩余量折算的口径留待索引器 filledIn 关联后启用，
 *   见轮文档后续安排。
 *
 * 深度口径：名义额 = amountIn × price / 1e18（quote 计价，wei）。
 * 积分 = Σ 名义额 × 时长（秒），单位 quote-wei·秒，与合约
 * ContributorReward 的 CAP_POSTING = 1e24 归一化口径对应
 * （submitProof 的 postingMetric 字段承载原始积分，合约侧封顶归一）。
 *
 * 防刷基线（本轮）：同一地址同一交易对同时在场的订单名义额合计超过
 * POSTING_NOTIONAL_CAP_PER_PAIR 的部分不计分（按时间顺序先到先计）——
 * 纯函数层即可执行的封顶，合约侧 CAP_POSTING 再封一层。
 */

/** 单个订单的生命周期记录（由 D1 导出 + 索引器成交关联拼出） */
export interface PostingLifecycleRecord {
  /** EIP-712 order digest（小写 0x…） */
  digest: string
  /** 挂单人地址（小写） */
  maker: string
  /** 交易对，如 BTC/USDT */
  pair: string
  /** amountIn（wei 整数字符串，Token0 数量） */
  amountIn: string
  /** price（wei 整数字符串，amountOut/amountIn × 1e18 口径，与中继/节点同形状） */
  price: string
  /** 签名 timestamp（Unix 秒） */
  createdAt: number
  /** 签名到期（Unix 秒） */
  expiresAt: number
  /** 全量成交时刻（Unix 秒，索引器 blockTimestamp）；未全量成交为 null */
  filledAt: number | null
}

export interface PostingMeterOptions {
  /** 周期窗口 [periodStart, periodEnd)（Unix 秒） */
  periodStart: number
  periodEnd: number
  /** 同地址同交易对同时在场名义额封顶（quote wei，BigInt）；缺省 1e24（= 100 万 quote 单位） */
  notionalCapPerPair?: bigint
}

export interface PostingScore {
  maker: string
  /** 总积分（quote-wei·秒，十进制字符串） */
  score: string
  /** 计入的订单数 */
  orders: number
  /** 计入的总挂单时长（秒，所有订单求和，非墙钟去重） */
  seconds: number
}

const WEI = 10n ** 18n
export const DEFAULT_NOTIONAL_CAP_PER_PAIR = 10n ** 24n

/** 名义额（quote wei）：amountIn × price / 1e18，非法输入按 0 */
export function orderNotionalWei(amountIn: string, price: string): bigint {
  try {
    const a = BigInt(amountIn)
    const p = BigInt(price)
    if (a <= 0n || p <= 0n) return 0n
    return (a * p) / WEI
  } catch {
    return 0n
  }
}

interface Segment {
  maker: string
  pair: string
  notional: bigint
  start: number
  end: number
  digest: string
}

/** 订单 → 周期内有效段（无交叠或非法输入返回 null） */
export function toSegment(
  rec: PostingLifecycleRecord,
  periodStart: number,
  periodEnd: number,
): Segment | null {
  const notional = orderNotionalWei(rec.amountIn, rec.price)
  if (notional <= 0n) return null
  const rawEnd = rec.filledAt ?? rec.expiresAt
  const end = Math.min(rawEnd, rec.expiresAt, periodEnd)
  const start = Math.max(rec.createdAt, periodStart)
  if (end <= start) return null
  return {
    maker: rec.maker.toLowerCase(),
    pair: rec.pair,
    notional,
    start,
    end,
    digest: rec.digest.toLowerCase(),
  }
}

/**
 * 按地址汇总挂单积分（含同对同时在场封顶）：
 * 封顶在每个时刻截面生效——实现上把每 (maker, pair) 的段按起点排序，
 * 用事件扫描逐段累加「在场名义额 ≤ cap」的时间片：超额部分按
 * 先到先计（起点早者优先，同起点按名义额大者优先）逐片削减。
 * 简化实现：逐段贪心——维护已接受段集合，对新段计算其与已接受段
 * 重叠区间的可用额度，按秒切片计分。段数是周期内订单量级（千级），
 * O(n²) 可接受；本函数是离线双周计量，不是热路径。
 */
export function meterPostings(
  records: PostingLifecycleRecord[],
  opts: PostingMeterOptions,
): PostingScore[] {
  const cap = opts.notionalCapPerPair ?? DEFAULT_NOTIONAL_CAP_PER_PAIR
  const segs = records
    .map((r) => toSegment(r, opts.periodStart, opts.periodEnd))
    .filter((s): s is Segment => s !== null)
    .sort((a, b) => a.start - b.start || (a.notional > b.notional ? -1 : 1))

  const byMaker = new Map<string, { score: bigint; orders: number; seconds: number }>()
  const accepted = new Map<string, Segment[]>() // key = maker|pair

  for (const seg of segs) {
    const key = `${seg.maker}|${seg.pair}`
    const prior = accepted.get(key) ?? []
    // 该段被计分的积分：逐秒切片太细——按与 prior 段的边界点切区间
    const cuts = new Set<number>([seg.start, seg.end])
    for (const p of prior) {
      if (p.start > seg.start && p.start < seg.end) cuts.add(p.start)
      if (p.end > seg.start && p.end < seg.end) cuts.add(p.end)
    }
    const points = [...cuts].sort((a, b) => a - b)
    let segScore = 0n
    let segSeconds = 0
    for (let i = 0; i + 1 < points.length; i++) {
      const t0 = points[i]
      const t1 = points[i + 1]
      if (t1 <= t0) continue
      let inField = 0n
      for (const p of prior) {
        if (p.start <= t0 && p.end >= t1) inField += p.notional
      }
      const room = cap > inField ? cap - inField : 0n
      const counted = seg.notional < room ? seg.notional : room
      if (counted > 0n) {
        segScore += counted * BigInt(t1 - t0)
        segSeconds += t1 - t0
      }
    }
    if (segScore > 0n) {
      prior.push(seg)
      accepted.set(key, prior)
      const agg = byMaker.get(seg.maker) ?? { score: 0n, orders: 0, seconds: 0 }
      agg.score += segScore
      agg.orders += 1
      agg.seconds += segSeconds
      byMaker.set(seg.maker, agg)
    }
  }

  return [...byMaker.entries()]
    .map(([maker, agg]) => ({
      maker,
      score: agg.score.toString(),
      orders: agg.orders,
      seconds: agg.seconds,
    }))
    .sort((a, b) => (BigInt(a.score) > BigInt(b.score) ? -1 : 1))
}
