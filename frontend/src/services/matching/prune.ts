/**
 * 批结算预检与剔腿（阶段 3 块 C2）——提交层规则，合约硬顶对齐：
 *
 * 1. 档位上限：单批最多 MAX_BATCH_LEGS 腿，与合约 MAX_BATCH_SIZE=50
 *    同值（合约常量改动时此处必须同改，execute.ts 有断言注释）。
 * 2. 预检模拟：整批先以 staticCall 模拟（eth_call 语义，不花 gas）；
 *    整批通过 → 原样提交。
 * 3. 剔腿：整批不过 → 逐腿单独模拟，剔除单独模拟也失败的腿（过期、
 *    锁被释放、累计量已被其他通道成交等陈旧腿）；剔除后整批再模拟，
 *    通过才提交。
 * 4. 整批原子性底线：剔腿后再模拟仍失败 → 整单不提交（宁可不成交，
 *    不拆批碰运气），由调用方给用户明确口径。全部腿被剔 → 同样不提交。
 *
 * simulate 以回调注入：生产实现走 ethers 合约 staticCall，本文件不
 * 依赖网络/钱包，可纯逻辑单测。
 */

export const MAX_BATCH_LEGS = 50

export interface PruneOutcome<T> {
  /** 最终可提交的腿（保持原相对序） */
  kept: T[]
  /** 被剔除的腿下标（相对入参 fills 的下标）与各自单独模拟的失败原因 */
  pruned: Array<{ index: number; reason: string }>
  /** 整批（含剔腿后）模拟是否通过；false = 整单不提交 */
  batchSimOk: boolean
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * @param fills 待提交的腿
 * @param simulateBatch 整批模拟（成功 resolve、失败 throw）
 * @param simulateOne 单腿模拟（成功 true、失败返回原因字符串）
 */
export async function simulateAndPrune<T>(
  fills: T[],
  simulateBatch: (batch: T[]) => Promise<void>,
  simulateOne: (one: T) => Promise<string | null>,
): Promise<PruneOutcome<T>> {
  if (fills.length === 0) return { kept: [], pruned: [], batchSimOk: false }
  try {
    await simulateBatch(fills)
    return { kept: fills, pruned: [], batchSimOk: true }
  } catch {
    // 整批不过 → 逐腿甄别陈旧腿
  }
  const kept: T[] = []
  const pruned: Array<{ index: number; reason: string }> = []
  for (let i = 0; i < fills.length; i++) {
    const reason = await simulateOne(fills[i])
    if (reason === null) kept.push(fills[i])
    else pruned.push({ index: i, reason })
  }
  if (kept.length === 0) return { kept, pruned, batchSimOk: false }
  try {
    await simulateBatch(kept)
    return { kept, pruned, batchSimOk: true }
  } catch {
    return { kept, pruned, batchSimOk: false }
  }
}

/** 档位上限截断：超限部分不进批次（余量按未成交处理），返回被截掉的腿数 */
export function capLegs<T>(legs: T[], cap = MAX_BATCH_LEGS): { capped: T[]; overflow: number } {
  if (legs.length <= cap) return { capped: legs, overflow: 0 }
  return { capped: legs.slice(0, cap), overflow: legs.length - cap }
}

export { errText }
