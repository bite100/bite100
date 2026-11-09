/**
 * bit100-mcp 公开入口冒烟（第 57 轮）：对已部署的 Worker 端点做真实
 * MCP 客户端实测。流程：
 *   生成一次性令牌 → 只把 SHA-256 哈希写进 D1 agents（临时 smoke agent）
 *   → 无令牌/错令牌各应 401 → 官方 SDK 客户端（Streamable HTTP）连接
 *   → listTools 应恰 7 个 → get_chain_config / get_orderbook /
 *     get_balances 三个只读工具实测 → place_order 小额实单（120 秒过期）
 *     并在中继簿中查到 → D1 急停置 1 时写拒（kill_switch_on）读通、
 *     复位 → 审计落库计数 > 0 → 退役 smoke agent（停用 + 换掉哈希），
 *     旧令牌应 401。
 * 令牌明文只活在本进程内存；结束时 agent 已停用且哈希被替换，
 * 旧令牌不可再用。本脚本可重复执行（每次新建一个 smoke agent 行，
 * 退役行保留作审计痕迹）。
 *
 * 用法：node worker/smoke.mjs（在 mcp/ 目录下）
 */
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const BASE = process.env.BIT100_MCP_URL ?? 'https://bit100-mcp.q3874758.workers.dev'
const ACCOUNT = '400bb171abd29b2362600dd677c5eca8'
const DB_NAME = 'bit100-mcp'
const HELPER = join(homedir(), 'workspace/custom-connectors/custom.cloudflare/bin/cf_api.py')
const MAKER_ADDR = '0xE83D2b08356cb463adFc20406a18B79991F7eE29'

let failures = 0
function report(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function sql(statement) {
  const list = execFileSync('python3', [HELPER, 'request', 'GET', `/client/v4/accounts/${ACCOUNT}/d1/database`], {
    encoding: 'utf8',
  })
  const dbId = JSON.parse(list.slice(list.indexOf('\n') + 1)).result.find((d) => d.name === DB_NAME).uuid
  const tmp = join('/tmp', `cf-smoke-${process.pid}.json`)
  writeFileSync(tmp, JSON.stringify({ sql: statement }), { mode: 0o600 })
  try {
    const out = execFileSync(
      'python3',
      [HELPER, 'request', 'POST', `/client/v4/accounts/${ACCOUNT}/d1/database/${dbId}/query`, '--data', tmp],
      { encoding: 'utf8' },
    )
    return JSON.parse(out.slice(out.indexOf('\n') + 1))
  } finally {
    try {
      unlinkSync(tmp)
    } catch {}
  }
}

function parseToolResult(res) {
  const text = (res.content ?? []).find((c) => c.type === 'text')?.text ?? ''
  try {
    return JSON.parse(text)
  } catch {
    return { ok: false, error: { code: 'unparseable', message: text.slice(0, 200) } }
  }
}

async function rawPost(token) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(BASE, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } },
    }),
  })
  return res.status
}

async function main() {
  const suffix = randomBytes(4).toString('hex')
  const agentId = `smoke-${suffix}`
  const token = randomBytes(24).toString('hex')
  const hash = createHash('sha256').update(token, 'utf8').digest('hex')

  sql(
    `INSERT INTO agents (id, token_hash, role, per_order_max_quote, daily_max_quote, write_rate_per_minute, enabled) VALUES ('${agentId}', '${hash}', 'maker', '10', '50', 10, 1)`,
  )
  console.log(`smoke agent seeded: ${agentId} (hash only in D1)`)

  report((await rawPost(null)) === 401, 'no token → 401')
  report((await rawPost('deadbeef'.repeat(6))) === 401, 'wrong token → 401')
  const health = await (await fetch(`${BASE}/health`)).json()
  report(health.ok === true && health.service === 'bit100-mcp', 'GET /health')

  const transport = new StreamableHTTPClientTransport(new URL(BASE), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name: 'bit100-mcp-smoke', version: '0.57.0' })
  await client.connect(transport)

  const tools = (await client.listTools()).tools.map((t) => t.name).sort()
  const expected = [
    'get_balances',
    'get_chain_config',
    'get_orderbook',
    'hard_cancel_order',
    'list_orders',
    'get_order_status',
    'place_order',
  ].sort()
  report(JSON.stringify(tools) === JSON.stringify(expected), 'listTools == 7 tools (no match_order)', tools.join(','))

  const cfg = parseToolResult(await client.callTool({ name: 'get_chain_config', arguments: { chainId: 11155111 } }))
  report(
    cfg.ok === true && cfg.data?.vault === '0x836cEFF0140aB66D8DD984ECb18765736BA121e9',
    'get_chain_config Sepolia (round-47 stack)',
    cfg.ok ? `vault=${cfg.data.vault}` : JSON.stringify(cfg).slice(0, 160),
  )

  const book = parseToolResult(
    await client.callTool({ name: 'get_orderbook', arguments: { chainId: 11155111, pair: 'TKA/TKB' } }),
  )
  report(book.ok === true, 'get_orderbook TKA/TKB via relay', book.ok ? '' : JSON.stringify(book).slice(0, 160))

  const bal = parseToolResult(
    await client.callTool({ name: 'get_balances', arguments: { chainId: 11155111, address: MAKER_ADDR } }),
  )
  report(bal.ok === true, 'get_balances maker (ethers reader on Workers)', bal.ok ? '' : JSON.stringify(bal).slice(0, 160))

  const placed = parseToolResult(
    await client.callTool({
      name: 'place_order',
      arguments: { chainId: 11155111, pair: 'TKA/TKB', side: 'sell', price: '1.5', amount: '0.1', ttlSeconds: 120 },
    }),
  )
  report(placed.ok === true && typeof placed.data?.digest === 'string', 'place_order via Worker signing', 
    placed.ok ? `digest=${placed.data.digest}` : JSON.stringify(placed).slice(0, 200))

  if (placed.ok) {
    const mine = parseToolResult(
      await client.callTool({
        name: 'list_orders',
        arguments: { chainId: 11155111, pair: 'TKA/TKB', userAddress: MAKER_ADDR },
      }),
    )
    const found = JSON.stringify(mine.data ?? {}).includes(placed.data.digest) || JSON.stringify(mine.data ?? {}).includes(placed.data.orderId)
    report(found, 'placed order visible in relay book')
  }

  // 限额：smoke agent 单笔上限 10（计价单位），挂 20 名义额应被拒且发生在签名之前
  const overCap = parseToolResult(
    await client.callTool({
      name: 'place_order',
      arguments: { chainId: 11155111, pair: 'TKA/TKB', side: 'sell', price: '2', amount: '10', ttlSeconds: 120 },
    }),
  )
  report(
    overCap.ok === false && overCap.error?.code === 'over_per_order_cap',
    'per-order cap → place_order rejected (D1 guard)',
    JSON.stringify(overCap.error ?? {}),
  )

  // 急停：D1 置 1 → 写拒、读通 → 复位
  sql(`UPDATE config SET value = '1' WHERE key = 'kill_switch'`)
  const blocked = parseToolResult(
    await client.callTool({
      name: 'place_order',
      arguments: { chainId: 11155111, pair: 'TKA/TKB', side: 'sell', price: '1.5', amount: '0.1', ttlSeconds: 120 },
    }),
  )
  report(blocked.ok === false && blocked.error?.code === 'kill_switch_on', 'kill_switch=1 → place_order rejected', JSON.stringify(blocked.error ?? {}))
  const readWhileKilled = parseToolResult(await client.callTool({ name: 'get_chain_config', arguments: { chainId: 11155111 } }))
  report(readWhileKilled.ok === true, 'kill_switch=1 → reads still work')
  sql(`UPDATE config SET value = '0' WHERE key = 'kill_switch'`)

  // 审计落库（waitUntil 刷盘后应有本 agent 的多行记录）
  await new Promise((r) => setTimeout(r, 3000))
  const auditRes = sql(`SELECT COUNT(*) AS n FROM audit_log WHERE agent_id = '${agentId}'`)
  const n = auditRes?.result?.[0]?.results?.[0]?.n ?? 0
  report(n >= 6, 'audit rows persisted in D1', `count=${n}`)

  await client.close()

  // 退役：停用 + 换掉哈希，旧令牌应立即失效
  const deadHash = createHash('sha256').update(randomBytes(32)).digest('hex')
  sql(`UPDATE agents SET enabled = 0, token_hash = '${deadHash}' WHERE id = '${agentId}'`)
  report((await rawPost(token)) === 401, 'retired token → 401')

  console.log(failures === 0 ? '\n===== SMOKE ALL PASS =====' : `\n===== SMOKE ${failures} FAILURES =====`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(`smoke crashed: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(2)
})
