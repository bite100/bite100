/**
 * 粗粒度固定窗口限流（第 59 轮块 4，审计 ③ 的防滥用层）：
 * 只用于 POST /orders 的入口削峰——状态在 Worker isolate 内存里，
 * isolate 重启即清零，多 isolate 之间不共享。**这不是额度账本**：
 * 任何与资金/配额有关的记账都必须走原子存储（见 MCP 侧 D1Guard），
 * 本模块存在的唯一理由是让伪造订单在烧 RPC 验签之前先撞一道便宜
 * 的墙。窗口 = 固定 60 秒（边界两侧各一个窗口属固定窗口的固有
 * 性质，防滥用层可接受）。
 */
export class FixedWindowRateLimiter {
  private windows = new Map<string, { startMs: number; count: number }>()

  constructor(private windowMs = 60_000) {}

  /** 本窗口内该 key 是否还可放行一次（放行即计数） */
  allow(key: string, limit: number, nowMs: number = Date.now()): boolean {
    const w = this.windows.get(key)
    if (!w || nowMs - w.startMs >= this.windowMs) {
      this.windows.set(key, { startMs: nowMs, count: 1 })
      // 顺手防 Map 无界增长：超大时整体清空（防滥用层，精度可弃）
      if (this.windows.size > 10_000) this.windows.clear()
      return true
    }
    if (w.count >= limit) return false
    w.count += 1
    return true
  }

  reset(): void {
    this.windows.clear()
  }
}
