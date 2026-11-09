/**
 * 工具注册的统一形状：每个工具 = 名字 + 说明 + zod 严格 schema +
 * handler。server.ts 把它们适配到 MCP 官方 SDK；单测直接调 handler。
 * 工具与协议层不包含任何针对单一 AI 客户端的假设——任何标准 MCP
 * 客户端拿到的都是同一套工具与结构化结果。
 */
import { z } from 'zod'
import type { RelayClient } from '../relay'
import type { ChainReader } from '../chain'
import type { AgentEntry, AgentRegistry, WriteGuard } from '../agents'
import type { AuditLog } from '../audit'
import { ToolError } from '../errors'

export interface ToolContext {
  relay: RelayClient
  chain: ChainReader
  registry: AgentRegistry
  guard: WriteGuard
  audit: Pick<AuditLog, 'append'>
  /** 本进程绑定的 agent 身份（启动时由令牌认证） */
  agent: AgentEntry
}

export interface ToolDef {
  name: string
  description: string
  schema: z.ZodObject<z.ZodRawShape>
  write: boolean
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>
}

export function parseArgs<T extends z.ZodObject<z.ZodRawShape>>(
  schema: T,
  args: Record<string, unknown>,
): z.infer<T> {
  const r = schema.safeParse(args)
  if (!r.success) {
    throw new ToolError(
      'invalid_params',
      `参数不合法: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    )
  }
  return r.data
}

export const chainIdField = z
  .number()
  .int()
  .describe('链 ID（仅允许测试网 11155111 Sepolia / 84532 Base Sepolia）')
export const addressField = z.string().regex(/^0x[0-9a-fA-F]{40}$/, '必须是 0x 地址')
export const digestField = z.string().regex(/^0x[0-9a-fA-F]{64}$/, '必须是 0x + 64 位十六进制的订单摘要')
