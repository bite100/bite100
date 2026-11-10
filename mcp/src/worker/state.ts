/**
 * Workers 形态的护栏状态层（第 57 轮建，第 59 轮记账协议重做）：把
 * 第 49 轮 stdio 版的三个进程内/文件后端——注册表 JSON、WriteGuard
 * 内存计数、审计 JSONL——换成 D1 实现：
 *
 * - 身份：Authorization Bearer 明文 → SHA-256（WebCrypto）→ D1
 *   agents.token_hash 比对（库里只存哈希，与 stdio 版注册表同口径）；
 * - 急停：D1 config.kill_switch='1' 或环境绑定 KILL_SWITCH='1'，
 *   任一成立即急停（写拒读通；切换 = 改一行 SQL 或绑定，不用重部署）；
 * - 限额（第 59 轮原子记账，修第 57 轮三条 P1 + 审计 ⑥⑦）：check =
 *   校验 + 立即预留，不再是「预取快照判定、成功后异步记账」：
 *   · 频率：单条「带门 INSERT」——INSERT ... SELECT ... WHERE
 *     (窗口内 COUNT < 上限)，计数与落行在同一条语句内原子完成
 *     （D1 语句串行执行）；changes=0 即超限拒绝。突发并发下恰好
 *     放行上限条数，不多放、也不整批误杀（朴素的先插后数会让一个
 *     突发把所有人一起顶超限、再全员拒绝）；
 *   · 每日名义额：单条条件 upsert——冲突时仅当
 *     total + 本笔 ≤ 每日上限才累加；changes=0 即超限，删掉本笔的
 *     频率事件行并拒绝。全新行走 INSERT 路径不受 WHERE 约束，故
 *     check 前已同步校验「单笔 ≤ 每日上限」兜底；
 *   · 中继接受（HTTP 200）后预留即正式记账，之后不回滚；投递失败
 *     走 release 只回滚每日预留（频率事件按口径永不回滚——通过
 *     check 的尝试无论成败都计频率，失败路径不再免费）；
 *   · 任一 D1 操作失败 → guard_unavailable 失败关闭：签名与投递都
 *     还没发生，绝不在护栏失明时放行写操作。
 * - 审计：仍经 PendingWrites 收集，但入口改为**返回响应前 await
 *   刷盘**（不再是 waitUntil 事后刷）：刷盘失败 → 重试一次 → 仍
 *   失败则入口回 500 而不是成功结果，丢失显性化（订单本身仍可凭
 *   digest 用读工具对账）。用量记账已同步化，不再走这条异步通道。
 * - 上限字段格式（审计 ⑦）：D1 行的 per_order_max_quote /
 *   daily_max_quote / write_rate_per_minute 在装配时按 stdio 注册表
 *   同一条规则校验（QUOTE_AMOUNT_RE + 整数区间）；非法 → 该 agent
 *   视为不可用（入口 401）并留一条 auth 审计，绝不让 NaN 把护栏
 *   静默关掉。
 */
import type { AgentEntry, AgentRegistry, WriteGuard } from '../agents'
import type { AuditEntry } from '../audit'
import { QUOTE_AMOUNT_RE } from '../caps'
import { ToolError } from '../errors'
import { REGISTER_RAMP_LIMITS, REGISTER_RAMP_WINDOW_MS } from './register'

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
  /** 第 59 轮 migration 0002 增列（旧行/测试行可能缺失，按缺省处理） */
  created_at?: number
  source?: string
}

/** 待刷盘语句收集器：第 59 轮起只承载审计行，请求返回前由入口 await 刷盘 */
class PendingWrites {
  private stmts: D1PreparedStatement[] = []

  add(stmt: D1PreparedStatement): void {
    this.stmts.push(stmt)
  }

  async flush(db: D1Database): Promise<void> {
    if (this.stmts.length === 0) return
    const batch = [...this.stmts]
    // 必须等 batch 成功后才出队：先清空再 await 的话，一次刷盘失败
    // 就把语句弄丢了，入口的「重试一次」只会刷一个空队列然后假装
    // 成功——那正是第 57 轮审计静默丢失的同款形状（第 59 轮验收
    // 测试实测抓到）。
    await db.batch(batch)
    this.stmts.splice(0, batch.length)
  }
}

/**
 * D1 版写护栏：与 agents.ts 的 WriteGuard 同一记账协议（check 预留 /
 * release 只回滚每日名义额），区别只在预留落在 D1 且每条语句原子
 * 执行——跨请求并发下限额不突破（第 57 轮快照口径就此关闭）。
 * check/release 为 async（D1 I/O）；工具层统一 await，对 stdio 的
 * 同步实现同样成立。
 */
class D1Guard {
  /** 本实例最近一次成功 check 的 UTC 日（release 按此日回滚） */
  private reservedDay: string | null = null

  constructor(
    private db: D1Database,
    private killOn: boolean,
  ) {}

  async check(agent: AgentEntry, notionalQuote: number): Promise<void> {
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
    // 条件 upsert 的全新行 INSERT 路径不受 WHERE 约束：先同步挡住
    // 「首笔即超每日上限」（与 stdio WriteGuard 同一条兜底）。
    if (notionalQuote > Number(agent.dailyMaxQuote)) {
      throw new ToolError(
        'over_daily_cap',
        `单笔名义额 ${notionalQuote} 本身超过 agent ${agent.id} 的每日上限 ${agent.dailyMaxQuote}，已拒绝`,
      )
    }

    const now = Date.now()
    const day = new Date(now).toISOString().slice(0, 10)
    let rateRowId: number | null = null
    try {
      // 顺带清理该 agent 两分钟前的频率事件，表体积有界
      await this.db
        .prepare('DELETE FROM rate_events WHERE agent_id = ? AND ts_ms < ?')
        .bind(agent.id, now - 120_000)
        .run()
      // 频率：带门 INSERT 单语句原子准入（见文件头）——窗口内已有
      // 上限条数时这行根本插不进去（changes=0）。
      const ins = await this.db
        .prepare(
          `INSERT INTO rate_events (agent_id, ts_ms)
           SELECT ?, ? WHERE (SELECT COUNT(*) FROM rate_events WHERE agent_id = ? AND ts_ms >= ?) < ?`,
        )
        .bind(agent.id, now, agent.id, now - 60_000, agent.writeRatePerMinute)
        .run()
      if (ins.meta.changes === 0) {
        throw new ToolError(
          'rate_limited',
          `agent ${agent.id} 写操作超过频率上限 ${agent.writeRatePerMinute}/分钟，已拒绝`,
        )
      }
      rateRowId = ins.meta.last_row_id ?? null
      // 每日名义额：条件 upsert 原子累加，changes=0 = 存量 + 本笔超限。
      if (notionalQuote > 0) {
        const res = await this.db
          .prepare(
            `INSERT INTO usage_daily (agent_id, day, total_quote) VALUES (?, ?, ?)
             ON CONFLICT(agent_id, day) DO UPDATE SET total_quote = total_quote + excluded.total_quote
             WHERE usage_daily.total_quote + excluded.total_quote <= ?`,
          )
          .bind(agent.id, day, notionalQuote, Number(agent.dailyMaxQuote))
          .run()
        if (res.meta.changes === 0) {
          await this.deleteRateEvent(rateRowId)
          const cur = await this.db
            .prepare('SELECT total_quote FROM usage_daily WHERE agent_id = ? AND day = ?')
            .bind(agent.id, day)
            .first<{ total_quote: number }>()
          throw new ToolError(
            'over_daily_cap',
            `今日累计名义额将达到 ${(cur?.total_quote ?? 0) + notionalQuote}，超过 agent ${agent.id} 的每日上限 ${agent.dailyMaxQuote}，已拒绝`,
          )
        }
      }
    } catch (e) {
      if (e instanceof ToolError) throw e
      // D1 故障 → 失败关闭：此刻尚未签名、尚未投递，不存在未授权
      // 写；本笔已落的频率事件行一并 best-effort 删掉，不让存储
      // 故障顺带吃掉 agent 的频率额度。
      await this.deleteRateEvent(rateRowId)
      throw new ToolError(
        'guard_unavailable',
        '护栏状态存储（D1）不可用，写操作失败关闭（未签名、未投递）',
      )
    }
    this.reservedDay = day
  }

  /**
   * 回滚每日名义额预留（投递失败时调用）。频率事件不回滚。回滚自身
   * 失败只会让该 agent 当日额度偏紧（失败关闭方向），记录日志即可，
   * 绝不掩盖触发回滚的原始错误。
   */
  async release(agent: AgentEntry, notionalQuote: number): Promise<void> {
    if (!(notionalQuote > 0) || !this.reservedDay) return
    try {
      await this.db
        .prepare('UPDATE usage_daily SET total_quote = MAX(total_quote - ?, 0) WHERE agent_id = ? AND day = ?')
        .bind(notionalQuote, agent.id, this.reservedDay)
        .run()
    } catch (e) {
      console.error(
        `[bit100-mcp] 每日额度预留回滚失败 agent=${agent.id}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  private async deleteRateEvent(rowId: number | null): Promise<void> {
    if (rowId == null) return
    try {
      await this.db.prepare('DELETE FROM rate_events WHERE rowid = ?').bind(rowId).run()
    } catch {
      // 删不掉只多占一个频率名额（失败关闭方向），不改变拒绝结论
    }
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

/**
 * D1 行的上限字段是否合法（审计 ⑦）：与 stdio 注册表 zod 同一条规则。
 * 历史上 Worker 侧漏了这层：非数字 TEXT 经 Number() 变 NaN 后，
 * `notional > NaN` 恒假，两道金额护栏会静默失效。
 */
export function agentCapsValid(row: {
  per_order_max_quote: unknown
  daily_max_quote: unknown
  write_rate_per_minute: unknown
}): boolean {
  return (
    typeof row.per_order_max_quote === 'string' &&
    QUOTE_AMOUNT_RE.test(row.per_order_max_quote) &&
    typeof row.daily_max_quote === 'string' &&
    QUOTE_AMOUNT_RE.test(row.daily_max_quote) &&
    Number.isInteger(row.write_rate_per_minute) &&
    (row.write_rate_per_minute as number) >= 1 &&
    (row.write_rate_per_minute as number) <= 600
  )
}

/** 按 Bearer 令牌装配一次请求的护栏状态；令牌无效/配置非法返回 null（入口回 401） */
export async function buildRequestState(env: WorkerEnv, token: string): Promise<RequestState | null> {
  const db = env.DB
  const hash = await sha256Hex(token)
  const row = await db.prepare('SELECT * FROM agents WHERE token_hash = ?').bind(hash).first<AgentRow>()
  if (!row) return null

  if (!agentCapsValid(row)) {
    // 配置非法 → 失败关闭：不用这行装配任何护栏，best-effort 留痕。
    try {
      await db
        .prepare(
          'INSERT INTO audit_log (ts, agent_id, tool, params_json, result, tx_hash, error_code) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(new Date().toISOString(), row.id, 'auth', '{}', 'error', null, 'invalid_agent_config')
        .run()
    } catch {
      // 留痕失败不改变失败关闭的结论（入口照样回 401）
    }
    return null
  }

  const agent: AgentEntry = {
    id: row.id,
    tokenHash: row.token_hash,
    role: row.role,
    perOrderMaxQuote: row.per_order_max_quote,
    dailyMaxQuote: row.daily_max_quote,
    writeRatePerMinute: row.write_rate_per_minute,
    enabled: row.enabled === 1,
  }

  // 自助注册 agent 的头 24 小时爬坡（块 3）：有效限额 = 行内限额与
  // 爬坡常量取 min；过窗后自动恢复，不需要定时任务改行。手工/冒烟
  // agent（source != 'register'）不受影响。
  if (
    row.source === 'register' &&
    typeof row.created_at === 'number' &&
    row.created_at > 0 &&
    Date.now() - row.created_at < REGISTER_RAMP_WINDOW_MS
  ) {
    agent.perOrderMaxQuote = String(
      Math.min(Number(agent.perOrderMaxQuote), Number(REGISTER_RAMP_LIMITS.perOrderMaxQuote)),
    )
    agent.dailyMaxQuote = String(
      Math.min(Number(agent.dailyMaxQuote), Number(REGISTER_RAMP_LIMITS.dailyMaxQuote)),
    )
    agent.writeRatePerMinute = Math.min(agent.writeRatePerMinute, REGISTER_RAMP_LIMITS.writeRatePerMinute)
  }

  const cfg = await db
    .prepare("SELECT value FROM config WHERE key = 'kill_switch'")
    .first<{ value: string }>()
  const killOn = env.KILL_SWITCH === '1' || cfg?.value === '1'

  const pending = new PendingWrites()
  const guard = new D1Guard(db, killOn)
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
