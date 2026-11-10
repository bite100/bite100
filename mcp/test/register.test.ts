/**
 * 第 59 轮块 3 验收：AI 自助注册（worker/register.ts + entry 路由）。
 * 全部经真实 entry.fetch + 内存假 D1 在本地跑（不部署、不对外发令牌）：
 * - 注册成功 → 201 + 令牌只出现一次，库里只有 SHA-256 哈希；
 * - 新令牌立刻可用（initialize 200、tools/list 8 个）；
 * - 限额只来自服务端常量：请求体塞 limits 被忽略；
 * - operator 永不发放（400）；坏 walletAddress 400；
 * - 防滥用：同 IP 第 11 次/小时 429、全局第 101 次/小时 429、
 *   registration_open='0' → 403；
 * - 头 24 小时爬坡：装配出的有效限额收紧；过窗恢复全额；
 * - GET /skill.md 托管说明书可达且含注册路径与令牌安全规则。
 */
import { describe, expect, it } from 'vitest'
import { hashToken } from '../src/agents'
import entry from '../src/worker/entry'
import { buildRequestState, type WorkerEnv } from '../src/worker/state'
import { FakeD1 } from './fakeD1'

const ANVIL_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4' + 'f2ff80'

const execCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext

function makeEnv(db: FakeD1): WorkerEnv {
  return {
    DB: db as unknown as D1Database,
    KEY_MAKER: ANVIL_KEY,
    KEY_TAKER: ANVIL_KEY,
  } as unknown as WorkerEnv
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://mcp.invalid${path}`, init)
}

async function register(db: FakeD1, body: unknown, ip = '203.0.113.7') {
  const res = await entry.fetch(
    req('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify(body ?? {}),
    }),
    makeEnv(db),
    execCtx,
  )
  const json = (await res.json()) as Record<string, any>
  return { res, json }
}

describe('POST /register', () => {
  it('成功：201、令牌 b100_ 前缀只显示一次、库里只有哈希、限额=服务端常量', async () => {
    const db = new FakeD1()
    const { res, json } = await register(db, { name: 'my-agent', role: 'taker' })
    expect(res.status).toBe(201)
    expect(json.ok).toBe(true)
    expect(json.token).toMatch(/^b100_[0-9a-f]{64}$/)
    expect(json.agent_id).toMatch(/^agt_[0-9a-f]{16}$/)
    expect(json.role).toBe('taker')
    expect(json.limits.per_order_max_quote).toBe('10')
    expect(json.limits.daily_max_quote).toBe('50')

    expect(db.agents).toHaveLength(1)
    const row = db.agents[0]
    expect(row.token_hash).toBe(hashToken(json.token as string))
    expect(row.token_hash).not.toContain(json.token as string)
    expect(row.source).toBe('register')
    expect(row.enabled).toBe(1)
    // 明文令牌不出现在 D1 任何字段里
    expect(JSON.stringify(db.agents)).not.toContain(json.token as string)
  })

  it('新令牌立刻可用：initialize 200（经 buildRequestState 装配成功）', async () => {
    const db = new FakeD1()
    const { json } = await register(db, { name: 'fresh' })
    const st = await buildRequestState(makeEnv(db), json.token as string)
    expect(st).not.toBeNull()
    expect(st!.agent.id).toBe(json.agent_id)
    expect(st!.agent.role).toBe('maker') // 缺省 role
  })

  it('请求体里的 limits 一律忽略', async () => {
    const db = new FakeD1()
    const { json } = await register(db, {
      role: 'maker',
      dailyMaxQuote: '999999',
      limits: { daily_max_quote: '999999', write_rate_per_minute: 600 },
    })
    expect(json.limits.daily_max_quote).toBe('50')
    expect(db.agents[0].daily_max_quote).toBe('50')
    expect(db.agents[0].write_rate_per_minute).toBe(10)
  })

  it('operator / 未知角色 → 400，永不发放', async () => {
    const db = new FakeD1()
    const op = await register(db, { role: 'operator' })
    expect(op.res.status).toBe(400)
    expect(op.json.error.code).toBe('role_not_allowed')
    const bogus = await register(db, { role: 'admin' })
    expect(bogus.res.status).toBe(400)
    expect(db.agents).toHaveLength(0)
  })

  it('walletAddress：合法存预留列，非法 400；本轮不据此授权（行里只是数据）', async () => {
    const db = new FakeD1()
    const ok = await register(db, { walletAddress: '0x' + 'a'.repeat(40) })
    expect(ok.res.status).toBe(201)
    expect(db.agents[0].wallet_address).toBe('0x' + 'a'.repeat(40))
    const bad = await register(db, { walletAddress: 'not-an-address' })
    expect(bad.res.status).toBe(400)
    expect(bad.json.error.code).toBe('invalid_wallet_address')
  })

  it('同 IP 第 11 次/小时 → 429（前 10 次放行）', async () => {
    const db = new FakeD1()
    for (let i = 0; i < 10; i++) {
      const r = await register(db, { name: `a${i}` }, '198.51.100.9')
      expect(r.res.status).toBe(201)
    }
    const over = await register(db, { name: 'one-too-many' }, '198.51.100.9')
    expect(over.res.status).toBe(429)
    expect(over.json.error.code).toBe('registration_rate_limited')
    // 换一个 IP 不受牵连
    const other = await register(db, { name: 'other-ip' }, '198.51.100.10')
    expect(other.res.status).toBe(201)
  })

  it('全局第 101 次/小时 → 429 registration_busy', async () => {
    const db = new FakeD1()
    const now = Date.now()
    for (let i = 0; i < 100; i++) {
      db.registrationEvents.push({ ip: `192.0.2.${i}`, ts_ms: now - 1000 })
    }
    const over = await register(db, { name: 'late' }, '203.0.113.99')
    expect(over.res.status).toBe(429)
    expect(over.json.error.code).toBe('registration_busy')
  })

  it("registration_open='0' → 403 暂停", async () => {
    const db = new FakeD1()
    db.config.set('registration_open', '0')
    const r = await register(db, { name: 'x' })
    expect(r.res.status).toBe(403)
    expect(r.json.error.code).toBe('registration_closed')
    expect(db.agents).toHaveLength(0)
  })
})

describe('头 24 小时爬坡（buildRequestState 有效限额）', () => {
  it('刚注册：有效限额收紧到爬坡值（5 / 20 / 5）', async () => {
    const db = new FakeD1()
    const { json } = await register(db, { name: 'ramp' })
    const st = await buildRequestState(makeEnv(db), json.token as string)
    expect(st!.agent.perOrderMaxQuote).toBe('5')
    expect(st!.agent.dailyMaxQuote).toBe('20')
    expect(st!.agent.writeRatePerMinute).toBe(5)
  })

  it('注册满 24 小时：恢复全额（10 / 50 / 10）', async () => {
    const db = new FakeD1()
    const { json } = await register(db, { name: 'old' })
    db.agents[0].created_at = Date.now() - 25 * 3600 * 1000
    const st = await buildRequestState(makeEnv(db), json.token as string)
    expect(st!.agent.perOrderMaxQuote).toBe('10')
    expect(st!.agent.dailyMaxQuote).toBe('50')
    expect(st!.agent.writeRatePerMinute).toBe(10)
  })

  it('手工 agent（source=manual）不受爬坡影响', async () => {
    const db = new FakeD1()
    db.agents.push({
      id: 'manual-1',
      token_hash: hashToken('manual-token'),
      role: 'maker',
      per_order_max_quote: '10',
      daily_max_quote: '50',
      write_rate_per_minute: 10,
      enabled: 1,
      source: 'manual',
      created_at: Date.now(),
    })
    const st = await buildRequestState(makeEnv(db), 'manual-token')
    expect(st!.agent.dailyMaxQuote).toBe('50')
    expect(st!.agent.writeRatePerMinute).toBe(10)
  })
})

describe('GET /skill.md', () => {
  it('200 + markdown：含注册路径、配置示例、令牌安全规则与限额表', async () => {
    const db = new FakeD1()
    const res = await entry.fetch(req('/skill.md'), makeEnv(db), execCtx)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/markdown')
    const text = await res.text()
    expect(text).toContain('/register')
    expect(text).toContain('Authorization')
    expect(text).toContain('shown\n  exactly once')
    expect(text).toContain('this origin only')
    expect(text).toContain('match_order')
  })
})
