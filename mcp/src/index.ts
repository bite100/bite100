/**
 * 入口：组装上下文并以 stdio 方式提供 MCP 服务。
 *
 * 启动环境（见 mcp/README.md）：
 *   BIT100_MCP_AGENTS_CONFIG  agent 注册表 JSON 路径（必填）
 *   BIT100_MCP_AGENT_TOKEN    本进程的 agent 令牌明文（必填，只用于启动认证）
 *   BIT100_MCP_RELAY_URL      中继地址（缺省生产中继）
 *   BIT100_MCP_AUDIT_DIR      审计日志目录（缺省 ./audit）
 *   BIT100_MCP_KEYFILE_MAKER / _TAKER / _OPERATOR  测试钥 env 文件路径（写工具用）
 *   BIT100_MCP_KILL_SWITCH=1 全局急停
 *
 * 私钥只在写工具首次使用时经环境注入的文件路径读取（signers.ts），
 * 本文件与注册表都不接触私钥。
 */
import { join } from 'node:path'
import { AgentRegistry, WriteGuard } from './agents'
import { AuditLog } from './audit'
import { EthersChainReader } from './chain'
import { relayUrl } from './config'
import { RelayClient } from './relay'
import { serveStdio } from './server'
import type { ToolContext } from './tools/common'

async function main(): Promise<void> {
  const configPath = process.env.BIT100_MCP_AGENTS_CONFIG
  const token = process.env.BIT100_MCP_AGENT_TOKEN
  if (!configPath) throw new Error('缺少环境变量 BIT100_MCP_AGENTS_CONFIG（agent 注册表路径）')
  if (!token) throw new Error('缺少环境变量 BIT100_MCP_AGENT_TOKEN（本进程的 agent 令牌）')

  const registry = AgentRegistry.load(configPath)
  const agent = registry.authenticate(token)
  const ctx: ToolContext = {
    relay: new RelayClient(relayUrl()),
    chain: new EthersChainReader(),
    registry,
    guard: new WriteGuard(registry),
    audit: new AuditLog(process.env.BIT100_MCP_AUDIT_DIR ?? join(process.cwd(), 'audit')),
    agent,
  }
  // stderr 是日志通道（stdout 专供 MCP 协议）
  console.error(
    `[bit100-mcp] agent=${agent.id} role=${agent.role} enabled=${agent.enabled} killSwitch=${registry.killSwitchOn()} relay=${relayUrl()}`,
  )
  await serveStdio(ctx)
}

main().catch((e) => {
  console.error(`[bit100-mcp] 启动失败: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
