/**
 * Workers 形态的护栏状态层（第 57 轮）：把第 49 轮 stdio 版的三个
 * 进程内/文件后端——注册表 JSON、WriteGuard 内存计数、审计 JSONL——
 * 换成 D1 实现，语义逐项对齐（映射表见 round57 文档）：
 *
 * - 身份：Authorization Bearer 明文 → SHA-256（WebCrypto）→ D1
 *   agents.token_hash 比对（库里只存哈希，与 stdio 版注册表同口径）；
 * - 急停：D1 config.kill_switch='1' 或环境绑定 KILL_SWITCH='1'，
 *   任一成立即急停（写拒读通；切换 = 改一行 SQL 或绑定，不用重部署）；
 * - 限额：请求开始时从 D1 预取当日累计 + 近 60 秒写事件，check/record
 *   的判定顺序与错误码与 WriteGuard 逐项一致；record 与审计的落库
 *   经 waitUntil 异步批量刷盘（usage_daily 用增量 upsert，刷盘竞态下
 *   总量仍然正确累加）。
 *
 * 并发口径（如实记录）：跨请求并发时 check 用的是预取快照，极端并发
 * 下限额可能被短暂小幅突破；审计与落库总量不受影响。测试网练习入口
 * 可接受；产品化若要严格串行化，用 D1 事务/队列另行加固。
 */
import { ToolError } from '../errors'
import type { AgentEntry, AgentRegistry, WriteGuard } from '../agents'
import type { AuditEntry } from '../audit'

export interface WorkerEnv {
  DB: D1Database
  /** 角色测试钥（secret_text 绑定；只在写工具首次签名时经钩子读取） */
  KEY_MAKER?: string
  KEY_TAKER?: string
  KEY_OPERATOR?: string
  /** 急停环境开关（与 D1 config.kill_switch 任一成立即急停） */
  KILL_SWITCH?: string
  /** 中继地址覆盖（缺省用 config.ts 的生产中继） */
  RELAY_URL?: string
  /**
   * 到中继 Worker 的服务绑定：Worker 内用全局 fetch 访问另一个
   * workers.dev 地址会吃 1042（实测），同账号 Worker 间必须走
   * service binding（部署 metadata 里绑 bit100-relay）。
   */
  RELAY?: Fetcher
}

export function keyForRole(env: WorkerEnv, role: string): string | null {
  if (role === 'maker') return env.KEY_MAKER ?? null
  if (role === 'taker') return env.KEY_TAKER ?? null
  if (role === 'operator') return env.KEY_OPERATOR ?? null
  return null
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

interface AgentRow {
  id: string
  token_hash: string
  role: AgentEntry['role']
  per_order_max_quote: string
  daily_max_quote: string
  write_rate_per_minute: number
  enabled: number
}

/** 待刷盘语句收集器：record/审计只入队，请求结束时经 waitUntil 批量落库 */
class PendingWrites {
  private stmts: D1PreparedStatement[] = []

  add(stmt: D1PreparedStatement): void {
    this.stmts.push(stmt)
  }

  async flush(db: D1Database): Promise<void> {
    if (this.stmts.length === 0) return
    const batch = this.stmts
    this.stmts = []
    await db.batch(batch)
  }
}

/**
 * D1 版写护栏：判定逻辑与 agents.ts 的 WriteGuard 逐项同构（顺序、
 * 错误码、文案口径一致），区别只在计数来源（D1 预取快照）与落库方式
 * （增量 upsert + 事件插入，经 PendingWrites 刷盘）。
 */
class D1Guard {
  private rateLog: number[]

  constructor(
    private db: D1Database,
    private pending: PendingWrites,
    private killOn: boolean,
    private dayTotal: number,
    rateLog: number[],
  ) {
    this.rateLog = rateLog
  }

  check(agent: AgentEntry, notionalQuote: number): void {
    if (!agent.enabled) {
      throw new ToolError('agent_disabled', `agent ${agent.id} 已被停用，写操作拒绝`)
    }
    if (this.killOn) {
      throw new ToolError('kill_switch_on', '全局急停已开启：全部写操作拒绝（读操作不受影响）')
    }
    if (!Number.isFinite(notionalQuote) || notionalQuote < 0) {
      throw new ToolError('invalid_amount', '名义额非法')
    }
    if (notionalQuote > Number(agent.perOrderMaxQuote)) {
      throw new ToolError(
        'over_per_order_cap',
        `单笔名义额 ${notionalQuote} 超过 agent ${agent.id} 的单笔上限 ${agent.perOrderMaxQuote}（计价代币单位），已拒绝`,
      )
    }
    if (this.dayTotal + notionalQuote > Number(agent.dailyMaxQuote)) {
      throw new ToolError(
        'over_daily_cap',
        `今日累计名义额将达到 ${this.dayTotal + notionalQuote}，超过 agent ${agent.id} 的每日上限 ${agent.dailyMaxQuote}，已拒绝`,
      )
    }
    const now = Date.now()
    const log = this.rateLog.filter((t) => now - t < 60_000)
    if (log.length >= agent.writeRatePerMinute) {
      throw new ToolError('rate_limited', `agent ${agent.id} 写操作超过频率上限 ${agent.writeRatePerMinute}/分钟，已拒绝`)
    }
    this.rateLog = log
  }

  record(agent: AgentEntry, notionalQuote: number): void {
    this.dayTotal += notionalQuote
    const now = Date.now()
    this.rateLog.push(now)
    const day = new Date().toISOString().slice(0, 10)
    this.pending.add(
      this.db
        .prepare(
          `INSERT INTO usage_daily (agent_id, day, total_quote) VALUES (?, ?, ?)
           ON CONFLICT(agent_id, day) DO UPDATE SET total_quote = total_quote + excluded.total_quote`,
        )
        .bind(agent.id, day, notionalQuote),
    )
    this.pending.add(
      this.db.prepare('INSERT INTO rate_events (agent_id, ts_ms) VALUES (?, ?)').bind(agent.id, now),
    )
    // 顺带清理该 agent 两分钟前的频率事件，表体积有界
    this.pending.add(
      this.db.prepare('DELETE FROM rate_events WHERE agent_id = ? AND ts_ms < ?').bind(agent.id, now - 120_000),
    )
  }
}

/**
 * 注册表快照：HTTP 装配只依赖 killSwitchOn（经 D1Guard 内部持有同一
 * killOn，工具层并不直接调用 registry——已按源码核对）；byId 与
 * authenticate 在 HTTP 请求路径上不会被调用（认证在入口层完成），
 * 这里给出失败关闭的实现而不是假装可用。
 */
function snapshotRegistry(killOn: boolean): AgentRegistry {
  const obj = {
    killSwitchOn: () => killOn,
    byId: () => undefined,
    authenticate: () => {
      throw new ToolError('unauthorized', 'HTTP 形态的身份认证在入口层完成，注册表 authenticate 不可用')
    },
  }
  return obj as unknown as AgentRegistry
}

export interface RequestState {
  agent: AgentEntry
  registry: AgentRegistry
  guard: WriteGuard
  audit: { append: (entry: AuditEntry) => void }
  flush: () => Promise<void>
}

/** 按 Bearer 令牌装配一次请求的护栏状态；令牌无效返回 null（入口回 401） */
export async function buildRequestState(env: WorkerEnv, token: string): Promise<RequestState | null> {
  const db = env.DB
  const hash = await sha256Hex(token)
  const row = await db.prepare('SELECT * FROM agents WHERE token_hash = ?').bind(hash).first<AgentRow>()
  if (!row) return null

  const agent: AgentEntry = {
    id: row.id,
    tokenHash: row.token_hash,
    role: row.role,
    perOrderMaxQuote: row.per_order_max_quote,
    dailyMaxQuote: row.daily_max_quote,
    writeRatePerMinute: row.write_rate_per_minute,
    enabled: row.enabled === 1,
  }

  const cfg = await db
    .prepare("SELECT value FROM config WHERE key = 'kill_switch'")
    .first<{ value: string }>()
  const killOn = env.KILL_SWITCH === '1' || cfg?.value === '1'

  const day = new Date().toISOString().slice(0, 10)
  const usage = await db
    .prepare('SELECT total_quote FROM usage_daily WHERE agent_id = ? AND day = ?')
    .bind(agent.id, day)
    .first<{ total_quote: number }>()
  const since = Date.now() - 60_000
  const rates = await db
    .prepare('SELECT ts_ms FROM rate_events WHERE agent_id = ? AND ts_ms >= ? ORDER BY ts_ms')
    .bind(agent.id, since)
    .all<{ ts_ms: number }>()

  const pending = new PendingWrites()
  const guard = new D1Guard(db, pending, killOn, usage?.total_quote ?? 0, rates.results.map((r) => r.ts_ms))
  const audit = {
    append: (entry: AuditEntry) => {
      pending.add(
        db
          .prepare(
            'INSERT INTO audit_log (ts, agent_id, tool, params_json, result, tx_hash, error_code) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(
            entry.ts,
            entry.agentId,
            entry.tool,
            JSON.stringify(entry.params),
            entry.result,
            entry.txHash ?? null,
            entry.errorCode ?? null,
          ),
      )
    },
  }

  return {
    agent,
    registry: snapshotRegistry(killOn),
    guard: guard as unknown as WriteGuard,
    audit,
    flush: () => pending.flush(db),
  }
}
