/**
 * 内存假 D1（第 59 轮）：实现 worker/state.ts（及后续 register.ts）
 * 用到的语句形状，供 D1Guard 原子记账的验收测试使用。
 *
 * 语义对齐：每条语句在被调用时同步执行完毕（await 点即串行化点），
 * 与真实 D1「单语句原子、写串行」一致——于是并发验收是确定性的：
 * 两条交错的 check 里，每条 SQL 看到的都是已落库的真实行数，而不是
 * 某个请求开始时的旧快照。
 *
 * 故障注入：failOn(substr) 让包含该子串的语句抛错；failBatch 让
 * batch() 抛错（审计刷盘失败路径用）。
 */
export interface FakeAgentRow {
  id: string
  token_hash: string
  role: string
  per_order_max_quote: string
  daily_max_quote: string
  write_rate_per_minute: number
  enabled: number
}

export interface FakeAuditRow {
  ts: string
  agent_id: string
  tool: string
  params_json: string
  result: string
  tx_hash: string | null
  error_code: string | null
}

function norm(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

class FakeStmt {
  private binds: unknown[] = []

  constructor(
    private db: FakeD1,
    readonly sql: string,
  ) {}

  bind(...b: unknown[]): FakeStmt {
    this.binds = b
    return this
  }

  async first<T>(): Promise<T | null> {
    return this.db.execFirst(this.sql, this.binds) as T | null
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.execAll(this.sql, this.binds) as T[] }
  }

  async run(): Promise<{ meta: { changes: number; last_row_id?: number } }> {
    const r = this.db.execRun(this.sql, this.binds)
    return { meta: { changes: r.changes, last_row_id: r.lastRowId } }
  }

  /** batch 内部执行入口 */
  runSync(): number {
    return this.db.execRun(this.sql, this.binds).changes
  }
}

export class FakeD1 {
  agents: FakeAgentRow[] = []
  config = new Map<string, string>([['kill_switch', '0']])
  /** key = `${agent_id}|${day}` → total_quote */
  usage = new Map<string, number>()
  rateEvents: { rowid: number; agent_id: string; ts_ms: number }[] = []
  audit: FakeAuditRow[] = []
  registrationEvents: { ip: string; ts_ms: number }[] = []

  private nextRowId = 1
  private failSubstrings = new Set<string>()
  failBatch = false

  failOn(substr: string): void {
    this.failSubstrings.add(substr)
  }

  clearFailures(): void {
    this.failSubstrings.clear()
    this.failBatch = false
  }

  private maybeFail(sql: string): void {
    for (const s of this.failSubstrings) {
      if (sql.includes(s)) throw new Error(`fake d1 failure (injected: ${s})`)
    }
  }

  prepare(sql: string): FakeStmt {
    return new FakeStmt(this, sql)
  }

  async batch(stmts: FakeStmt[]): Promise<unknown[]> {
    if (this.failBatch) throw new Error('fake d1 batch failure (injected)')
    for (const s of stmts) s.runSync()
    return []
  }

  usageTotal(agentId: string, day: string): number {
    return this.usage.get(`${agentId}|${day}`) ?? 0
  }

  execFirst(sqlRaw: string, b: unknown[]): unknown {
    const sql = norm(sqlRaw)
    this.maybeFail(sql)
    if (sql.includes('FROM agents') && sql.includes('token_hash')) {
      return this.agents.find((r) => r.token_hash === b[0]) ?? null
    }
    if (sql.includes('FROM config')) {
      const m = sql.match(/key = '([^']+)'/)
      const key = m ? m[1] : (b[0] as string)
      const v = this.config.get(key)
      return v === undefined ? null : { value: v }
    }
    if (sql.includes('COUNT(*)') && sql.includes('FROM rate_events')) {
      const n = this.rateEvents.filter(
        (r) => r.agent_id === b[0] && r.ts_ms >= (b[1] as number),
      ).length
      return { n }
    }
    if (sql.includes('COUNT(*)') && sql.includes('FROM registration_events')) {
      // 两种形状：按 ip 计数（带 ip = ?）与全局计数（只有 ts 条件）
      const rows = sql.includes('ip = ?')
        ? this.registrationEvents.filter((r) => r.ip === b[0] && r.ts_ms >= (b[1] as number))
        : this.registrationEvents.filter((r) => r.ts_ms >= (b[0] as number))
      return { n: rows.length }
    }
    if (sql.includes('SELECT total_quote FROM usage_daily')) {
      const key = `${b[0]}|${b[1]}`
      return this.usage.has(key) ? { total_quote: this.usage.get(key) } : null
    }
    throw new Error(`fake d1: unhandled first() ${sql}`)
  }

  execAll(sqlRaw: string, _b: unknown[]): unknown[] {
    const sql = norm(sqlRaw)
    this.maybeFail(sql)
    throw new Error(`fake d1: unhandled all() ${sql}`)
  }

  execRun(sqlRaw: string, b: unknown[]): { changes: number; lastRowId?: number } {
    const sql = norm(sqlRaw)
    this.maybeFail(sql)
    if (sql.includes('INSERT INTO audit_log')) {
      this.audit.push({
        ts: b[0] as string,
        agent_id: b[1] as string,
        tool: b[2] as string,
        params_json: b[3] as string,
        result: b[4] as string,
        tx_hash: (b[5] as string | null) ?? null,
        error_code: (b[6] as string | null) ?? null,
      })
      return { changes: 1 }
    }
    if (sql.includes('INSERT INTO rate_events') && sql.includes('SELECT')) {
      // 带门 INSERT：窗口内计数 < 上限（bind[4]）才落行
      const count = this.rateEvents.filter(
        (r) => r.agent_id === b[2] && r.ts_ms >= (b[3] as number),
      ).length
      if (count >= (b[4] as number)) return { changes: 0 }
      const rowid = this.nextRowId++
      this.rateEvents.push({ rowid, agent_id: b[0] as string, ts_ms: b[1] as number })
      return { changes: 1, lastRowId: rowid }
    }
    if (sql.includes('DELETE FROM rate_events') && sql.includes('rowid')) {
      const before = this.rateEvents.length
      this.rateEvents = this.rateEvents.filter((r) => r.rowid !== b[0])
      return { changes: before - this.rateEvents.length }
    }
    if (sql.includes('DELETE FROM rate_events') && sql.includes('ts_ms <')) {
      const before = this.rateEvents.length
      this.rateEvents = this.rateEvents.filter(
        (r) => !(r.agent_id === b[0] && r.ts_ms < (b[1] as number)),
      )
      return { changes: before - this.rateEvents.length }
    }
    if (sql.includes('INSERT INTO usage_daily')) {
      // 条件 upsert：无行 → INSERT（changes 1）；有行 → 仅当
      // total + delta <= cap（bind[3]）才累加（changes 1），否则 0。
      const key = `${b[0]}|${b[1]}`
      const delta = b[2] as number
      if (!this.usage.has(key)) {
        this.usage.set(key, delta)
        return { changes: 1 }
      }
      const cur = this.usage.get(key)!
      if (cur + delta <= (b[3] as number)) {
        this.usage.set(key, cur + delta)
        return { changes: 1 }
      }
      return { changes: 0 }
    }
    if (sql.includes('UPDATE usage_daily')) {
      const key = `${b[1]}|${b[2]}`
      if (!this.usage.has(key)) return { changes: 0 }
      this.usage.set(key, Math.max(this.usage.get(key)! - (b[0] as number), 0))
      return { changes: 1 }
    }
    if (sql.includes('INSERT INTO registration_events')) {
      this.registrationEvents.push({ ip: b[0] as string, ts_ms: b[1] as number })
      return { changes: 1 }
    }
    if (sql.includes('INSERT INTO agents')) {
      // binds 顺序与 register.ts 的 INSERT 列顺序一致
      const [id, token_hash, role, per_order, daily, rate, enabled, name, created_at, source, wallet] =
        b as [string, string, string, string, string, number, number, string | null, number, string, string | null]
      if (this.agents.some((r) => r.id === id || r.token_hash === token_hash)) {
        throw new Error('fake d1: UNIQUE constraint failed (agents)')
      }
      this.agents.push({
        id,
        token_hash,
        role,
        per_order_max_quote: per_order,
        daily_max_quote: daily,
        write_rate_per_minute: rate,
        enabled,
        ...(name !== undefined ? { name } : {}),
        ...(created_at !== undefined ? { created_at } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(wallet !== undefined ? { wallet_address: wallet } : {}),
      } as FakeAgentRow)
      return { changes: 1 }
    }
    throw new Error(`fake d1: unhandled run() ${sql}`)
  }
}
