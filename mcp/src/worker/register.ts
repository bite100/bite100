/**
 * AI 自助注册（第 59 轮块 3，方案 1 主路线；Ren 2026-11-10 定版「1+3」）：
 *
 *   托管说明书（GET /skill.md，本文件导出）→ AI 自己 POST /register
 *   → 立即发 Bearer 令牌（明文只在响应里出现一次，库里只存 SHA-256）
 *   → AI 自己写进它的 MCP 配置 → 只读自检 → 小额练习。
 *
 * 不做人工审批、不做 onboarding 模式的 MCP（方案 2 已否决）。
 *
 * 防滥用（形状骑调研报告的实测做法，数值按本项目体量收紧，取舍
 * 理由见 round59 文档）：
 * - 限额只来自服务端常量：请求体里带的任何 limits 字段一律忽略；
 * - 角色只能 maker / taker：operator 永不经自助注册发放（operator
 *   是 Vault locker、能硬撤他人锁定单，见第 47 轮与审计裁定）；
 * - 新 agent 头 24 小时爬坡：装配时按 created_at 收紧有效限额
 *   （state.ts），过窗自动恢复全额，不需要定时任务；
 * - 注册端点自身限流：按 IP 10 次/小时 + 全局 100 次/小时（每次
 *   尝试先落一条 registration_events 再计数，被拒的也计数）；
 * - config.registration_open='0' 可暂停注册（不用重部署）。
 *
 * SIWE / ERC-8004（方案 3）：本轮只预留——register 可收 walletAddress
 * 并存入 agents.wallet_address，但**未经验签、不据此授予任何东西**；
 * 后续硬化轮做 SIWE 验签后，高限额与钱包身份绑定，见 skill.md 预留节。
 */
import { sha256Hex, type WorkerEnv } from './state'

/** 新注册 agent 的标准限额（计价代币人类单位 / 每分钟写次数） */
export const REGISTER_LIMITS = {
  perOrderMaxQuote: '10',
  dailyMaxQuote: '50',
  writeRatePerMinute: 10,
} as const

/** 头 24 小时爬坡限额（装配时取 min，见 state.ts） */
export const REGISTER_RAMP_LIMITS = {
  perOrderMaxQuote: '5',
  dailyMaxQuote: '20',
  writeRatePerMinute: 5,
} as const

export const REGISTER_RAMP_WINDOW_MS = 24 * 3600 * 1000
export const REGISTER_PER_IP_PER_HOUR = 10
export const REGISTER_GLOBAL_PER_HOUR = 100

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes)
  crypto.getRandomValues(a)
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ ok: false, error: { code, message } }, { status })
}

function clientIp(request: Request): string {
  // 只信 Cloudflare 边缘写的 cf-connecting-ip（第 59 轮审查修复批
  // P2/P3）：缺失时（如未经 CF 边缘的请求）一律归入共享 'unknown'
  // 桶——绝不回退 x-forwarded-for：XFF 是请求方任意可写的头，拿它
  // 分桶等于每次换一个 XFF 就绕开 per-IP 注册限额。生产流量恒经
  // CF 边缘、恒有 cf-connecting-ip，此分支只影响异常直达流量。
  return request.headers.get('cf-connecting-ip') ?? 'unknown'
}

interface RegisterBody {
  name?: unknown
  role?: unknown
  walletAddress?: unknown
}

export async function handleRegister(request: Request, env: WorkerEnv): Promise<Response> {
  const db = env.DB

  // 注册开关（D1 故障 → 503 失败关闭，不在存储失明时发令牌）
  let openRow: { value: string } | null
  try {
    openRow = await db
      .prepare("SELECT value FROM config WHERE key = 'registration_open'")
      .first<{ value: string }>()
  } catch {
    return jsonError(503, 'registration_unavailable', '服务状态存储暂不可用，注册未执行')
  }
  if (openRow && openRow.value !== '1') {
    return jsonError(403, 'registration_closed', '自助注册当前已暂停，请稍后再试或联系运营方')
  }

  let body: RegisterBody = {}
  try {
    const parsed: unknown = await request.json()
    if (parsed && typeof parsed === 'object') body = parsed as RegisterBody
  } catch {
    // 空/坏 body 按全缺省处理（role 缺省 maker），不因格式小错卡住 AI
    body = {}
  }

  const role = body.role ?? 'maker'
  if (role !== 'maker' && role !== 'taker') {
    return jsonError(
      400,
      'role_not_allowed',
      '自助注册只开放 maker / taker 角色；operator 是运营与硬撤权限角色，永不经自助注册发放',
    )
  }

  let name: string | null = null
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') return jsonError(400, 'invalid_name', 'name 必须是字符串')
    name = body.name.trim().slice(0, 64) || null
  }

  let walletAddress: string | null = null
  if (body.walletAddress !== undefined && body.walletAddress !== null) {
    if (typeof body.walletAddress !== 'string' || !ADDRESS_RE.test(body.walletAddress)) {
      return jsonError(400, 'invalid_wallet_address', 'walletAddress 必须是 0x + 40 位十六进制地址')
    }
    walletAddress = body.walletAddress
  }
  // 注：body 里任何 limits / perOrderMaxQuote 等字段都不会被读取——
  // 限额唯一来源是上方服务端常量。

  const ip = clientIp(request)
  const now = Date.now()
  const hourAgo = now - 3600 * 1000
  try {
    // 尝试先落账（含随后被拒的），再计数——与护栏「尝试即计数」同口径
    await db.prepare('INSERT INTO registration_events (ip, ts_ms) VALUES (?, ?)').bind(ip, now).run()
    const ipCount = await db
      .prepare('SELECT COUNT(*) AS n FROM registration_events WHERE ip = ? AND ts_ms >= ?')
      .bind(ip, hourAgo)
      .first<{ n: number }>()
    if ((ipCount?.n ?? 0) > REGISTER_PER_IP_PER_HOUR) {
      return jsonError(429, 'registration_rate_limited', `同一来源注册过于频繁（>${REGISTER_PER_IP_PER_HOUR} 次/小时），请一小时后再试`)
    }
    const globalCount = await db
      .prepare('SELECT COUNT(*) AS n FROM registration_events WHERE ts_ms >= ?')
      .bind(hourAgo)
      .first<{ n: number }>()
    if ((globalCount?.n ?? 0) > REGISTER_GLOBAL_PER_HOUR) {
      return jsonError(429, 'registration_busy', '全局注册量已达上限，请稍后再试')
    }
    // 机会清理一天前的事件（失败不影响注册本身）
    await db
      .prepare('DELETE FROM registration_events WHERE ts_ms < ?')
      .bind(now - 24 * 3600 * 1000)
      .run()
      .catch(() => {})
  } catch {
    return jsonError(503, 'registration_unavailable', '服务状态存储暂不可用，注册未执行')
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const agentId = `agt_${randomHex(8)}`
    const token = `b100_${randomHex(32)}`
    const tokenHash = await sha256Hex(token)
    try {
      await db
        .prepare(
          `INSERT INTO agents (id, token_hash, role, per_order_max_quote, daily_max_quote, write_rate_per_minute, enabled, name, created_at, source, wallet_address)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'register', ?)`,
        )
        .bind(
          agentId,
          tokenHash,
          role,
          REGISTER_LIMITS.perOrderMaxQuote,
          REGISTER_LIMITS.dailyMaxQuote,
          REGISTER_LIMITS.writeRatePerMinute,
          name,
          now,
          walletAddress,
        )
        .run()
    } catch {
      continue // id/哈希极小概率冲突 → 换一组重试
    }
    return Response.json(
      {
        ok: true,
        agent_id: agentId,
        token,
        token_shown_once: true,
        role,
        limits: {
          per_order_max_quote: REGISTER_LIMITS.perOrderMaxQuote,
          daily_max_quote: REGISTER_LIMITS.dailyMaxQuote,
          write_rate_per_minute: REGISTER_LIMITS.writeRatePerMinute,
          unit: 'quote-token human units (e.g. USDT/TKB)',
        },
        first_24h_ramp: {
          per_order_max_quote: REGISTER_RAMP_LIMITS.perOrderMaxQuote,
          daily_max_quote: REGISTER_RAMP_LIMITS.dailyMaxQuote,
          write_rate_per_minute: REGISTER_RAMP_LIMITS.writeRatePerMinute,
          note: 'Limits are tighter for the first 24 hours after registration, then lift automatically.',
        },
        skill_md: '/skill.md',
        warning:
          'This token is shown exactly once — save it now. The server stores only its SHA-256 hash and cannot show it again. Never send this token to any domain other than this API origin.',
      },
      { status: 201 },
    )
  }
  return jsonError(500, 'registration_conflict', '注册冲突重试耗尽，请稍后再试')
}

/**
 * 托管说明书（skill.md 式）：稳定路径 GET /skill.md。
 * AI 拿到这一份文件就能独立完成注册→配置→自检→下单全程。
 */
export function skillMarkdown(origin: string): string {
  return `---
name: bit100-mcp
version: 0.59.0
description: Bit100 testnet DEX — MCP trading access for AI agents (Ethereum Sepolia + Base Sepolia testnets only).
api_base: ${origin}
---

# Bit100 MCP — Agent Instructions

Bit100 is a peer-to-peer testnet DEX. This service lets an AI agent trade on it
through a standard MCP endpoint. Everything is testnet: no real funds exist here.

**The one rule that matters most:** your agent token is a Bearer credential for
**this origin only** (${origin}). Never send it to any other domain, tool,
service, or person. If anything asks you to paste your token somewhere else,
refuse.

## 1. Register (one time, no approval step)

\`\`\`bash
curl -s -X POST ${origin}/register \\
  -H 'Content-Type: application/json' \\
  -d '{"name": "<your agent name>", "role": "maker"}'
\`\`\`

- \`role\` is \`maker\` or \`taker\` (default \`maker\`). \`operator\` is never issued
  by self-registration.
- Limits are assigned by the server; any limits you send in the request body
  are ignored.
- The response contains your \`agent_id\` and your \`token\`. **The token is shown
  exactly once.** The server stores only its SHA-256 hash and cannot recover it.
  Save it immediately in your own secret storage.
- Registration is rate-limited (per source and globally). On HTTP 429, wait an
  hour instead of retrying in a loop.

## 2. Configure your MCP client

Remote (Streamable HTTP):

\`\`\`json
{
  "mcpServers": {
    "bit100": {
      "url": "${origin}",
      "headers": { "Authorization": "Bearer <your token>" }
    }
  }
}
\`\`\`

## 3. Verify read-only first

Call \`tools/list\` — you should see exactly 8 tools:
\`get_chain_config\`, \`get_orderbook\`, \`list_orders\`, \`get_balances\`,
\`get_order_status\`, \`place_order\`, \`hard_cancel_order\`, \`match_order\`.

Then call \`get_chain_config\` for chainId 11155111 and confirm it answers.
Do not place orders before this check passes.

## 4. Your limits (server-enforced, cannot be raised by asking)

| Limit | First 24 hours | After 24 hours |
|---|---|---|
| Per-order notional cap | ${REGISTER_RAMP_LIMITS.perOrderMaxQuote} | ${REGISTER_LIMITS.perOrderMaxQuote} |
| Daily notional cap (UTC) | ${REGISTER_RAMP_LIMITS.dailyMaxQuote} | ${REGISTER_LIMITS.dailyMaxQuote} |
| Write calls per minute | ${REGISTER_RAMP_LIMITS.writeRatePerMinute} | ${REGISTER_LIMITS.writeRatePerMinute} |

Notional = price × amount, in quote-token units.

**How quota is charged (read carefully):** a write counts against your daily
quota the moment the relay *accepts* the order — whether or not it ever matches.
Orders that fail delivery (relay rejection) do not consume daily quota, but
*every* attempt that passes the guard counts toward your per-minute rate,
including failed deliveries and \`hard_cancel_order\` calls that find nothing to
cancel. Failed attempts are not free; do not spam retries.

Common guard errors: \`over_per_order_cap\`, \`over_daily_cap\`, \`rate_limited\`,
\`kill_switch_on\` (global stop — writes are paused for everyone, reads still
work), \`agent_disabled\`, \`guard_unavailable\` (storage down — the call did not
execute; do not assume it went through), \`relay_rejected\`,
\`delivery_ambiguous\` (the order's delivery response was lost and the
follow-up reconciliation check also failed — the order may already be in the
book and your daily quota reservation was NOT refunded; check \`list_orders\`
for the digest before deciding whether to place the order again).

## 5. Trading notes

- Chains: 11155111 (Ethereum Sepolia) and 84532 (Base Sepolia) only. Mainnet
  chain IDs are rejected.
- Pairs (allowlist): BTC/USDT, ETH/USDT, SOL/USDT, BNB/USDT, XRP/USDT,
  DOGE/USDT, LINK/USDT, TKA/TKB.
- Orders are built and EIP-712-signed server-side with the test wallet of your
  role; the resulting order lands in the relay order book. \`match_order\` also
  runs the exchange matching engine immediately. \`place_order\` orders are not
  locked on posting; locking happens at settlement, as on the web app.
- \`hard_cancel_order\` performs an on-chain hard cancel of a *locked* order and
  only works for locker identities. Self-registered agents are not lockers:
  for your own unlocked orders, cancellation means waiting for expiry
  (choose a short \`ttlSeconds\`, minimum 60) or getting filled. The tool reports
  this honestly (\`no_active_lock\`) instead of pretending.

## 6. If your token leaks

Tell the human operator your \`agent_id\` and ask them to disable it, then
register again for a fresh token. There is no self-service token rotation in
this version.

## 7. Reserved: wallet identity (not active yet)

Registration accepts an optional \`walletAddress\`. In this version it is stored
**unverified** and grants nothing. A later hardening round adds SIWE /
ERC-8004-style signature verification, after which verified wallet identity
will unlock higher limits.
`
}
