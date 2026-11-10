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
 * 工具面：第 59 轮块 2 起与 stdio 全面对齐——只读 5 + place_order +
 * hard_cancel_order + match_order（共 8）。match_order 骑的前端撮合
 * 引擎经同一套 esbuild 打包进入 Worker（build-worker.mjs），双读的
 * 中继适配器通过 ctx 注入服务绑定 fetch（见 tools/common.ts）。
 *
 * MCP 请求（含只读）都要 Bearer 令牌，与 stdio 版「无令牌连工具都
 * 调不了」的口径一致。公开面只有三个：/health（只回服务名与时间）、
 * GET /skill.md（托管说明书）、POST /register（自助注册，第 59 轮
 * 块 3——发令牌的入口本身不可能先有令牌，靠端点限流+紧限额兜底）。
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { buildServer } from '../server'
import { readTools } from '../tools/read'
import { writeTools } from '../tools/write'
import { matchTools } from '../tools/match'
import { RelayClient } from '../relay'
import { EthersChainReader } from '../chain'
import { DEFAULT_RELAY_URL } from '../config'
import { _setKeyTextProvider } from '../signers'
import type { ToolContext } from '../tools/common'
import { buildRequestState, keyForRole, type WorkerEnv } from './state'
import { handleRegister, skillMarkdown } from './register'

function unauthorized(message: string): Response {
  return Response.json(
    { jsonrpc: '2.0', error: { code: -32001, message }, id: null },
    { status: 401 },
  )
}

export default {
  async fetch(request: Request, env: WorkerEnv, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'bit100-mcp', time: Date.now() })
    }
    // 第 59 轮块 3：自助注册与托管说明书是公开面（注册本身就是发
    // 令牌的入口，不可能要求先有令牌）；其余路径照旧全员要 Bearer。
    if (url.pathname === '/skill.md') {
      if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
      return new Response(skillMarkdown(url.origin), {
        headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
      })
    }
    if (url.pathname === '/register') {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
      return handleRegister(request, env)
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }
    const auth = request.headers.get('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : ''
    if (!token) return unauthorized('缺少 Authorization: Bearer <agent 令牌>')

    // 状态装配要读 D1；D1 故障时失败关闭：一个工具都不执行（也就
    // 不存在未授权签名），回 503 而不是把故障伪装成令牌问题。
    let state
    try {
      state = await buildRequestState(env, token)
    } catch {
      return Response.json(
        {
          jsonrpc: '2.0',
          error: { code: -32002, message: '服务状态存储暂不可用（D1），请求未执行' },
          id: null,
        },
        { status: 503 },
      )
    }
    if (!state) return unauthorized('令牌无效：未找到对应的 agent 身份')

    // 签名钥只经 secret 绑定注入（signers 钩子）；钥不进代码/配置/日志
    _setKeyTextProvider((role) => keyForRole(env, role))

    const relayBinding = env.RELAY
    const relayFetch = relayBinding ? (url: string, init?: RequestInit) => relayBinding.fetch(url, init) : undefined
    const toolCtx: ToolContext = {
      relay: new RelayClient(env.RELAY_URL ?? DEFAULT_RELAY_URL, relayFetch),
      chain: new EthersChainReader(),
      registry: state.registry,
      guard: state.guard,
      audit: state.audit,
      agent: state.agent,
      // 撮合工具的双读适配器同走服务绑定（块 2）
      relayBaseUrl: env.RELAY_URL ?? DEFAULT_RELAY_URL,
      relayFetch,
    }
    const server = buildServer(toolCtx, [...readTools, ...writeTools, ...matchTools])
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // 无状态：每请求独立装配（Workers 口径）
      enableJsonResponse: true,
    })
    await server.connect(transport)
    const response = await transport.handleRequest(request)
    // 第 59 轮（修第 57 轮 P1-③）：审计在**返回响应前** await 刷盘，
    // 使「成功响应」永远意味着审计已落库。用量记账已在 check 内
    // 同步落 D1（state.ts），不走这条通道。刷盘失败：重试一次；仍
    // 失败 → 丢弃成功结果回 500，丢失显性化——已发生的交易不回滚
    // （订单凭 digest 可用读工具对账），但本服务绝不假装记上了。
    try {
      await state.flush()
    } catch {
      try {
        await state.flush()
      } catch {
        return Response.json(
          {
            jsonrpc: '2.0',
            error: {
              code: -32003,
              message:
                '审计落库失败：本次调用结果未确认送达。任何已发生的交易不会被回滚，请凭订单 digest 用只读工具对账后再决定是否重试。',
            },
            id: null,
          },
          { status: 500 },
        )
      }
    }
    return response
  },
}
