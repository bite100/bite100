/**
 * 第 59 轮验收：Workers 公开入口（worker/entry.ts）本地装配测试。
 * 用内存假 D1 + 假中继服务绑定驱动真实 entry.fetch（不部署、不发网）：
 * - 工具面 8 个（含块 2 移植的 match_order）；
 * - 无令牌 401 / D1 故障 503（失败关闭，一个工具都不执行）；
 * - 急停时 place_order 在护栏层被拒：不签名、不投递；
 * - 审计刷盘失败 → HTTP 500 而非成功结果（块 1 的 P1-③ 入口面）。
 */
import { describe, expect, it } from 'vitest'
import { hashToken } from '../src/agents'
import entry from '../src/worker/entry'
import type { WorkerEnv } from '../src/worker/state'
import { FakeD1 } from './fakeD1'

const TOKEN = 'entry-test-token'
const ANVIL_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4' + 'f2ff80'

function seedDb(): FakeD1 {
  const db = new FakeD1()
  db.agents.push({
    id: 'w-agent',
    token_hash: hashToken(TOKEN),
    role: 'maker',
    per_order_max_quote: '100',
    daily_max_quote: '1000',
    write_rate_per_minute: 10,
    enabled: 1,
  })
  return db
}

function makeEnv(db: FakeD1) {
  let relayCalls = 0
  const env = {
    DB: db as unknown as D1Database,
    KEY_MAKER: ANVIL_KEY,
    RELAY: {
      fetch: async () => {
        relayCalls++
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    },
  } as unknown as WorkerEnv
  return { env, relayCalls: () => relayCalls }
}

const execCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext

function rpc(body: unknown, token?: string): Request {
  return new Request('https://mcp.invalid/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '0' },
  },
}

async function callRpc(env: WorkerEnv, body: unknown, token: string = TOKEN) {
  const res = await entry.fetch(rpc(body, token), env, execCtx)
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 保持 null，断言里带原文 */
  }
  return { res, json: json as { result?: any; error?: any } | null, text }
}

describe('Workers 公开入口', () => {
  it('initialize + tools/list → 8 个工具（含 match_order）', async () => {
    const db = seedDb()
    const { env } = makeEnv(db)
    const init = await callRpc(env, INITIALIZE)
    expect(init.res.status).toBe(200)
    const list = await callRpc(env, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    expect(list.res.status).toBe(200)
    const names = (list.json?.result?.tools ?? []).map((t: { name: string }) => t.name)
    expect(names).toHaveLength(8)
    expect(names).toContain('match_order')
    expect(names).toContain('place_order')
    expect(names).toContain('hard_cancel_order')
  })

  it('tools/call get_chain_config → 结构化结果，且审计已落库', async () => {
    const db = seedDb()
    const { env } = makeEnv(db)
    await callRpc(env, INITIALIZE)
    const out = await callRpc(env, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_chain_config', arguments: { chainId: 11155111 } },
    })
    expect(out.res.status).toBe(200)
    expect(out.json?.result?.isError).toBeFalsy()
    const content = JSON.stringify(out.json?.result?.content ?? [])
    expect(content).toContain('11155111')
    // 审计在响应返回前已刷盘（不是 waitUntil 事后补）
    expect(db.audit.some((a) => a.tool === 'get_chain_config' && a.result === 'ok')).toBe(true)
  })

  it('无令牌 → 401；错令牌 → 401', async () => {
    const db = seedDb()
    const { env } = makeEnv(db)
    const noTok = await entry.fetch(rpc(INITIALIZE), env, execCtx)
    expect(noTok.status).toBe(401)
    const badTok = await callRpc(env, INITIALIZE, 'wrong-token')
    expect(badTok.res.status).toBe(401)
  })

  it('D1 故障（agents 查询即抛）→ 503，失败关闭', async () => {
    const db = seedDb()
    db.failOn('FROM agents')
    const { env } = makeEnv(db)
    const out = await callRpc(env, INITIALIZE)
    expect(out.res.status).toBe(503)
  })

  it('急停开启 → place_order 被护栏拒（isError + kill_switch_on），中继零调用', async () => {
    const db = seedDb()
    db.config.set('kill_switch', '1')
    const { env, relayCalls } = makeEnv(db)
    await callRpc(env, INITIALIZE)
    const out = await callRpc(env, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'place_order',
        arguments: { chainId: 11155111, pair: 'TKA/TKB', side: 'sell', price: '2', amount: '1' },
      },
    })
    expect(out.res.status).toBe(200)
    expect(out.json?.result?.isError).toBe(true)
    expect(JSON.stringify(out.json?.result?.content ?? [])).toContain('kill_switch_on')
    expect(relayCalls()).toBe(0)
    // 被拒的调用也留审计（error 行）
    expect(db.audit.some((a) => a.tool === 'place_order' && a.result === 'error')).toBe(true)
  })

  it('审计刷盘失败（batch 注入故障）→ HTTP 500，不返回成功结果', async () => {
    const db = seedDb()
    const { env } = makeEnv(db)
    await callRpc(env, INITIALIZE)
    db.failBatch = true
    const out = await callRpc(env, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'get_chain_config', arguments: { chainId: 11155111 } },
    })
    expect(out.res.status).toBe(500)
    expect(JSON.stringify(out.json)).toContain('审计落库失败')
  })
})
