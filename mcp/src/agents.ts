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
import { ToolError } from './errors'

export const AGENT_ROLES = ['maker', 'taker', 'operator'] as const
export type AgentRole = (typeof AGENT_ROLES)[number]

const agentEntrySchema = z.object({
  id: z.string().min(1),
  /** 令牌的 SHA-256 十六进制哈希（明文令牌只在客户端与启动环境里） */
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  role: z.enum(AGENT_ROLES),
  /** 单笔名义额上限（计价代币人类单位，如 "50" = 50 USDT/TKB） */
  perOrderMaxQuote: z.string().regex(/^\d+(\.\d+)?$/),
  /** 每日累计名义额上限（同上单位，UTC 日） */
  dailyMaxQuote: z.string().regex(/^\d+(\.\d+)?$/),
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

/** 写操作护栏：身份启用状态 + 急停 + 限额 + 频率。计数在进程内。 */
export class WriteGuard {
  private dailyUsed = new Map<string, { day: string; total: number }>()
  private rateLog = new Map<string, number[]>()

  constructor(private registry: AgentRegistry) {}

  private today(): string {
    return new Date().toISOString().slice(0, 10)
  }

  /** 写前检查（不计数）；全部通过才放行 */
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
    this.rateLog.set(agent.id, log)
  }

  /** 写成功后记账（频率 + 每日累计） */
  record(agent: AgentEntry, notionalQuote: number): void {
    const day = this.today()
    const used = this.dailyUsed.get(agent.id)
    const total = (used && used.day === day ? used.total : 0) + notionalQuote
    this.dailyUsed.set(agent.id, { day, total })
    const log = this.rateLog.get(agent.id) ?? []
    log.push(Date.now())
    this.rateLog.set(agent.id, log)
  }
}
