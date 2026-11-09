/**
 * 公开入口（第 57 轮）：Bit100 MCP 的 Cloudflare Workers 形态。
 *
 * 与第 49 轮 stdio 形态的关系：工具层（tools/read + tools/write）、
 * 订单构建/签名（骑前端生产 digest/orderSigning）、链读（ethers）、
 * 中继转调、护栏判定语义全部复用同一份代码；本文件只换四件宿主后端：
 *   传输 stdio → 官方 SDK 的 WebStandard Streamable HTTP（无状态）；
 *   身份 进程启动令牌 → 每请求 Authorization: Bearer（D1 哈希比对）；
 *   注册表/限额/审计 文件+内存 → D1（src/worker/state.ts）；
 *   签名钥 env 文件 → Worker secret 绑定（经 signers 的注入钩子）。
 *
 * 工具面（v1）：只读 5 + place_order + hard_cancel_order。
 * match_order 暂未移植：它骑的前端撮合引擎（dualread + matching）是
 * 为浏览器/Node 装配的整包，Workers 移植需单独评估打包体积与运行时
 * 差异，留待下一轮；在补齐前客户端看到的工具清单里没有它，不假装。
 *
 * 全部请求（含只读）都要 Bearer 令牌，与 stdio 版「无令牌连工具都
 * 调不了」的口径一致。/health 例外（只回服务名与时间，无数据）。
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { buildServer } from '../server'
import { readTools } from '../tools/read'
import { writeTools } from '../tools/write'
import { RelayClient } from '../relay'
import { EthersChainReader } from '../chain'
import { DEFAULT_RELAY_URL } from '../config'
import { _setKeyTextProvider } from '../signers'
import type { ToolContext } from '../tools/common'
import { buildRequestState, keyForRole, type WorkerEnv } from './state'

function unauthorized(message: string): Response {
  return Response.json(
    { jsonrpc: '2.0', error: { code: -32001, message }, id: null },
    { status: 401 },
  )
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'bit100-mcp', time: Date.now() })
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }
    const auth = request.headers.get('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : ''
    if (!token) return unauthorized('缺少 Authorization: Bearer <agent 令牌>')

    const state = await buildRequestState(env, token)
    if (!state) return unauthorized('令牌无效：未找到对应的 agent 身份')

    // 签名钥只经 secret 绑定注入（signers 钩子）；钥不进代码/配置/日志
    _setKeyTextProvider((role) => keyForRole(env, role))

    const relayBinding = env.RELAY
    const toolCtx: ToolContext = {
      relay: new RelayClient(
        env.RELAY_URL ?? DEFAULT_RELAY_URL,
        relayBinding ? (url, init) => relayBinding.fetch(url, init) : undefined,
      ),
      chain: new EthersChainReader(),
      registry: state.registry,
      guard: state.guard,
      audit: state.audit,
      agent: state.agent,
    }
    const server = buildServer(toolCtx, [...readTools, ...writeTools])
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // 无状态：每请求独立装配（Workers 口径）
      enableJsonResponse: true,
    })
    await server.connect(transport)
    const response = await transport.handleRequest(request)
    // 审计与限额计数落库不阻塞响应，经 waitUntil 在响应后刷盘
    ctx.waitUntil(state.flush())
    return response
  },
}
