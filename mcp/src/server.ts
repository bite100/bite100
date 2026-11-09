/**
 * MCP 服务端装配：骑官方 MCP TypeScript SDK（@modelcontextprotocol/sdk，
 * 锁 1.32.2——调研报告指出官方正处 v1→v2 换代，本轮锁 v1 稳定线）。
 * 标准 MCP over stdio：任何 MCP 客户端（不限品牌/实现）都能接入，
 * 工具层没有任何针对单一客户端的假设。
 *
 * 每进程绑定一个 agent 身份（启动时用令牌对注册表认证）；每次工具
 * 调用都写一条按 agent 分文件的 append-only 审计日志。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { errResult, okResult, ToolError } from './errors'
import { readTools } from './tools/read'
import { writeTools } from './tools/write'
import { matchTools } from './tools/match'
import type { ToolContext, ToolDef } from './tools/common'

export function buildServer(
  ctx: ToolContext,
  tools: ToolDef[] = [...readTools, ...writeTools, ...matchTools],
): McpServer {
  const server = new McpServer({ name: 'bit100-mcp', version: '0.57.0' })
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema.shape },
      async (args: Record<string, unknown>) => {
        const started = new Date().toISOString()
        try {
          const data = await tool.handler(ctx, args ?? {})
          const txHash =
            data && typeof data === 'object' && 'txHash' in data && typeof (data as { txHash?: unknown }).txHash === 'string'
              ? (data as { txHash: string }).txHash
              : undefined
          ctx.audit.append({
            ts: started,
            agentId: ctx.agent.id,
            tool: tool.name,
            params: args ?? {},
            result: 'ok',
            ...(txHash ? { txHash } : {}),
          })
          return okResult(data)
        } catch (e) {
          const err =
            e instanceof ToolError
              ? e
              : new ToolError('internal', e instanceof Error ? e.message : String(e))
          ctx.audit.append({
            ts: started,
            agentId: ctx.agent.id,
            tool: tool.name,
            params: args ?? {},
            result: 'error',
            errorCode: err.code,
          })
          return errResult(err)
        }
      },
    )
  }
  return server
}

export async function serveStdio(ctx: ToolContext): Promise<void> {
  const server = buildServer(ctx)
  await server.connect(new StdioServerTransport())
}
