/**
 * 第 59 轮验收：Worker 侧 D1 护栏（worker/state.ts）。
 *
 * 覆盖简报块 1 的四项验收在 D1 后端上的对应面：
 * ① 每日上限并发不突破（原子条件 upsert，跨请求实例同样成立）；
 * ② 每分钟频率上限在并发下不突破（先落事件行再计数）；
 * ③ D1 故障 → guard_unavailable 失败关闭（签名/投递都不会发生）；
 * ④ release 只回滚每日预留、频率不回滚；
 * 另加简报条目 12：D1 上限字段非法 → 装配失败关闭 + auth 审计留痕；
 * 以及审计 flush 失败显性化（入口 500 的根因层）。
 */
import { describe, expect, it } from 'vitest'
import { hashToken } from '../src/agents'
import type { AuditEntry } from '../src/audit'
import { ToolError } from '../src/errors'
import { agentCapsValid, buildRequestState, type WorkerEnv } from '../src/worker/state'
import { FakeD1, type FakeAgentRow } from './fakeD1'

const TOKEN = 'worker-test-token'

function seedAgent(db: FakeD1, over: Partial<FakeAgentRow> = {}): void {
  db.agents.push({
    id: 'w-agent',
    token_hash: hashToken(TOKEN),
    role: 'maker',
    per_order_max_quote: '100',
    daily_max_quote: '50',
    write_rate_per_minute: 3,
    enabled: 1,
    ...over,
  })
}

function envOf(db: FakeD1): WorkerEnv {
  return { DB: db as unknown as D1Database }
}

async function stateOf(db: FakeD1) {
  const st = await buildRequestState(envOf(db), TOKEN)
  if (!st) throw new Error('buildRequestState 应成功')
  return st
}

/** guard.check 在类型上是同步签名，D1 实现是 async——测试统一按 Promise 用 */
function check(st: Awaited<ReturnType<typeof stateOf>>, notional: number): Promise<void> {
  return Promise.resolve(st.guard.check(st.agent, notional) as unknown as Promise<void>)
}
function release(st: Awaited<ReturnType<typeof stateOf>>, notional: number): Promise<void> {
  return Promise.resolve(st.guard.release(st.agent, notional) as unknown as Promise<void>)
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

async function expectToolError(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(ToolError)
    expect((e as ToolError).code).toBe(code)
    return
  }
  throw new Error(`期望 ToolError(${code})，但调用成功了`)
}

describe('agentCapsValid（简报条目 12：上限字段格式校验）', () => {
  const ok = { per_order_max_quote: '10', daily_max_quote: '50', write_rate_per_minute: 3 }
  it('合法行通过', () => {
    expect(agentCapsValid(ok)).toBe(true)
    expect(agentCapsValid({ ...ok, per_order_max_quote: '0.5' })).toBe(true)
  })
  it('非数字 / NaN 陷阱值一律拒绝', () => {
    for (const bad of ['abc', 'Infinity', '', ' ', '1e3', '0x10', '10.', '.5', '1,000']) {
      expect(agentCapsValid({ ...ok, per_order_max_quote: bad }), bad).toBe(false)
      expect(agentCapsValid({ ...ok, daily_max_quote: bad }), bad).toBe(false)
    }
  })
  it('频率非整数/越界拒绝', () => {
    for (const bad of [0, -1, 2.5, 601, '3', Number.NaN]) {
      expect(agentCapsValid({ ...ok, write_rate_per_minute: bad as number })).toBe(false)
    }
  })
})

describe('buildRequestState', () => {
  it('未知令牌 → null', async () => {
    const db = new FakeD1()
    seedAgent(db)
    expect(await buildRequestState(envOf(db), 'no-such-token')).toBeNull()
  })

  it('上限字段非法 → null（失败关闭）+ 留一条 invalid_agent_config 审计', async () => {
    const db = new FakeD1()
    seedAgent(db, { daily_max_quote: 'not-a-number' })
    expect(await buildRequestState(envOf(db), TOKEN)).toBeNull()
    expect(db.audit).toHaveLength(1)
    expect(db.audit[0].tool).toBe('auth')
    expect(db.audit[0].error_code).toBe('invalid_agent_config')
    expect(db.audit[0].agent_id).toBe('w-agent')
  })

  it('急停（D1 config）生效：check 抛 kill_switch_on', async () => {
    const db = new FakeD1()
    seedAgent(db)
    db.config.set('kill_switch', '1')
    const st = await stateOf(db)
    await expectToolError(check(st, 1), 'kill_switch_on')
  })
})

describe('D1Guard 原子记账（第 59 轮协议）', () => {
  it('① 每日上限：顺序两次 30（上限 50），第二次 over_daily_cap；用量恰为 30', async () => {
    const db = new FakeD1()
    seedAgent(db)
    const s1 = await stateOf(db)
    await check(s1, 30)
    // 第二个请求实例（新装配的护栏）必须看到第一个已落库的预留
    const s2 = await stateOf(db)
    await expectToolError(check(s2, 30), 'over_daily_cap')
    expect(db.usageTotal('w-agent', today())).toBe(30)
  })

  it('① 每日上限并发：两条 check(30) 同时跑，恰一条成功、一条 over_daily_cap', async () => {
    const db = new FakeD1()
    seedAgent(db, { write_rate_per_minute: 20 })
    const s1 = await stateOf(db)
    const s2 = await stateOf(db)
    const results = await Promise.allSettled([check(s1, 30), check(s2, 30)])
    const okCount = results.filter((r) => r.status === 'fulfilled').length
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(okCount).toBe(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'over_daily_cap' })
    expect(db.usageTotal('w-agent', today())).toBe(30)
  })

  it('② 频率并发：上限 3/分钟，6 条并发 check 恰 3 条通过、落库事件恰 3 行', async () => {
    const db = new FakeD1()
    seedAgent(db)
    const states = await Promise.all(Array.from({ length: 6 }, () => stateOf(db)))
    const results = await Promise.allSettled(states.map((s) => check(s, 0)))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3)
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(rejected).toHaveLength(3)
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'rate_limited' })
    }
    expect(db.rateEvents).toHaveLength(3)
  })

  it('④ release 只回滚每日预留：回滚后可再 check 同额；频率事件保留', async () => {
    const db = new FakeD1()
    seedAgent(db)
    const st = await stateOf(db)
    await check(st, 30)
    expect(db.usageTotal('w-agent', today())).toBe(30)
    await release(st, 30)
    expect(db.usageTotal('w-agent', today())).toBe(0)
    await check(st, 30)
    expect(db.usageTotal('w-agent', today())).toBe(30)
    // 两次 check 各落一条频率事件，release 不删
    expect(db.rateEvents).toHaveLength(2)
  })

  it('③ D1 故障（rate_events 写失败）→ guard_unavailable，且无任何预留落库', async () => {
    const db = new FakeD1()
    seedAgent(db)
    db.failOn('rate_events')
    const st = await stateOf(db)
    await expectToolError(check(st, 10), 'guard_unavailable')
    expect(db.usageTotal('w-agent', today())).toBe(0)
    expect(db.rateEvents).toHaveLength(0)
  })

  it('③ D1 故障（usage_daily 写失败）→ guard_unavailable，频率事件也已回滚删除', async () => {
    const db = new FakeD1()
    seedAgent(db)
    db.failOn('usage_daily')
    const st = await stateOf(db)
    await expectToolError(check(st, 10), 'guard_unavailable')
    expect(db.rateEvents).toHaveLength(0)
  })

  it('审计 flush：正常落库；batch 故障时 flush 抛错（入口据此回 500，不静默）', async () => {
    const db = new FakeD1()
    seedAgent(db)
    const st = await stateOf(db)
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      agentId: 'w-agent',
      tool: 'place_order',
      params: { pair: 'TKA/TKB' },
      result: 'ok',
    }
    st.audit.append(entry)
    await st.flush()
    expect(db.audit).toHaveLength(1)
    expect(db.audit[0].tool).toBe('place_order')

    const st2 = await stateOf(db)
    st2.audit.append(entry)
    db.failBatch = true
    await expect(st2.flush()).rejects.toThrowError(/batch failure/)
  })
})
