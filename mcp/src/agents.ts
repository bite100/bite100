/**
 * 护栏内核（全部硬编码在服务端，不依赖任何提示词约束）：
 * - agent 注册表：配置文件声明 id / 令牌哈希 / 钱包角色 / 单笔上限 /
 *   每日上限 / 频率上限 / enabled 开关。令牌只存 SHA-256 哈希。
 * - 全局急停：环境变量 BIT100_MCP_KILL_SWITCH=1，或配置文件同目录
 *   出现 kill-switch 文件 —— 任一成立即急停：写工具全拒，读工具照常。
 * - 链/交易对白名单在 config.ts；本模块管身份、限额与急停。
 *
 * 限额口径：以「计价代币（quote）的人类单位」计名义额
 * （名义额 = 成交价 × 数量）。计数器是进程内的（每日按 UTC 归零）；
 * 持久审计以 audit 日志为准——练习脚手架口径，文档已注明。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { QUOTE_AMOUNT_RE } from './caps'
import { ToolError } from './errors'

export { QUOTE_AMOUNT_RE } from './caps'

export const AGENT_ROLES = ['maker', 'taker', 'operator'] as const
export type AgentRole = (typeof AGENT_ROLES)[number]

const agentEntrySchema = z.object({
  id: z.string().min(1),
  /** 令牌的 SHA-256 十六进制哈希（明文令牌只在客户端与启动环境里） */
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  role: z.enum(AGENT_ROLES),
  /** 单笔名义额上限（计价代币人类单位，如 "50" = 50 USDT/TKB） */
  perOrderMaxQuote: z.string().regex(QUOTE_AMOUNT_RE),
  /** 每日累计名义额上限（同上单位，UTC 日） */
  dailyMaxQuote: z.string().regex(QUOTE_AMOUNT_RE),
  /** 每分钟写工具调用上限 */
  writeRatePerMinute: z.number().int().positive().max(600),
  enabled: z.boolean(),
})

const registrySchema = z.object({ agents: z.array(agentEntrySchema).min(1) })

export type AgentEntry = z.infer<typeof agentEntrySchema>

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export class AgentRegistry {
  private byHash = new Map<string, AgentEntry>()
  private killFile: string

  private constructor(
    entries: AgentEntry[],
    private configPath: string,
  ) {
    for (const e of entries) this.byHash.set(e.tokenHash, e)
    this.killFile = join(dirname(configPath), 'kill-switch')
  }

  static load(configPath: string): AgentRegistry {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(configPath, 'utf8'))
    } catch (e) {
      throw new Error(`agent 注册表读取失败 ${configPath}: ${e instanceof Error ? e.message : String(e)}`)
    }
    const parsed = registrySchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(`agent 注册表格式错误: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    }
    return new AgentRegistry(parsed.data.agents, configPath)
  }

  /** 按明文令牌查 agent（内部比对哈希；令牌不落日志） */
  authenticate(token: string): AgentEntry {
    const agent = this.byHash.get(hashToken(token))
    if (!agent) throw new ToolError('unauthorized', '令牌无效：未找到对应的 agent 身份')
    return agent
  }

  byId(id: string): AgentEntry | undefined {
    for (const e of this.byHash.values()) if (e.id === id) return e
    return undefined
  }

  /** 全局急停：环境变量或 kill-switch 文件任一成立 */
  killSwitchOn(): boolean {
    return process.env.BIT100_MCP_KILL_SWITCH === '1' || existsSync(this.killFile)
  }
}

/**
 * 写操作护栏：身份启用状态 + 急停 + 限额 + 频率。计数在进程内。
 *
 * 第 59 轮记账协议（与 Worker 侧 D1Guard 同构，修复第 57 轮三条 P1 +
 * 审计 ⑥）：旧协议是「check 不计数、成功后 record」——未成交的
 * match_order、被中继拒收的 place_order、中途返回的 hard_cancel 都不
 * 消耗任何额度，且并发下 check 看到的是同一份旧快照。新协议：
 * - check = 校验 + 立即预留：频率事件当场落账且**永不回滚**（每次
 *   通过 check 的写尝试都计频率——失败路径同样消耗，防免费刷 RPC）；
 *   每日名义额当场计入预留。进程内 check 函数体同步执行完，天然原子。
 * - release = 仅回滚每日名义额预留：投递失败（签名/组单失败、中继
 *   非 200）时调用；一旦中继接受（HTTP 200），预留即成正式记账，
 *   之后无论是否成交都不再回滚。
 */
export class WriteGuard {
  private dailyUsed = new Map<string, { day: string; total: number }>()
  private rateLog = new Map<string, number[]>()

  constructor(private registry: AgentRegistry) {}

  private today(): string {
    return new Date().toISOString().slice(0, 10)
  }

  /** 写前校验 + 预留（频率当场落账，每日名义额当场计入预留） */
  check(agent: AgentEntry, notionalQuote: number): void {
    if (!agent.enabled) {
      throw new ToolError('agent_disabled', `agent ${agent.id} 已被停用，写操作拒绝`)
    }
    if (this.registry.killSwitchOn()) {
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
    // 单笔已保证 ≤ 单笔上限；每日上限若小于单笔上限，还须单独挡住
    // 「首笔即超每日上限」（预留是直接累加，没有旧快照可依）。
    if (notionalQuote > Number(agent.dailyMaxQuote)) {
      throw new ToolError(
        'over_daily_cap',
        `单笔名义额 ${notionalQuote} 本身超过 agent ${agent.id} 的每日上限 ${agent.dailyMaxQuote}，已拒绝`,
      )
    }
    const day = this.today()
    const used = this.dailyUsed.get(agent.id)
    const usedToday = used && used.day === day ? used.total : 0
    if (usedToday + notionalQuote > Number(agent.dailyMaxQuote)) {
      throw new ToolError(
        'over_daily_cap',
        `今日累计名义额将达到 ${usedToday + notionalQuote}，超过 agent ${agent.id} 的每日上限 ${agent.dailyMaxQuote}，已拒绝`,
      )
    }
    const now = Date.now()
    const log = (this.rateLog.get(agent.id) ?? []).filter((t) => now - t < 60_000)
    if (log.length >= agent.writeRatePerMinute) {
      throw new ToolError('rate_limited', `agent ${agent.id} 写操作超过频率上限 ${agent.writeRatePerMinute}/分钟，已拒绝`)
    }
    // 全部通过 → 预留落账：频率事件 + 每日名义额同刻计入。
    log.push(now)
    this.rateLog.set(agent.id, log)
    this.dailyUsed.set(agent.id, { day, total: usedToday + notionalQuote })
  }

  /**
   * 回滚每日名义额预留（投递失败时调用）。频率事件不回滚——按口径，
   * 通过 check 的尝试无论成败都消耗频率。跨日边界：昨日的预留桶已
   * 失效，release 直接无操作。
   */
  release(agent: AgentEntry, notionalQuote: number): void {
    if (!(notionalQuote > 0)) return
    const day = this.today()
    const used = this.dailyUsed.get(agent.id)
    if (!used || used.day !== day) return
    this.dailyUsed.set(agent.id, {
      day,
      total: Math.max(0, used.total - notionalQuote),
    })
  }
}
