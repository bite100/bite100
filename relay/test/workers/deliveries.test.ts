import { SELF, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { TEST_ADDRESS, TEST_ADDRESS_2 } from '../helpers'

const BASE = 'http://relay.test'
let seq = 0
function deliveryId(): string {
  seq += 1
  return `trade-d${seq}:${TEST_ADDRESS.toLowerCase()}`
}

async function post(path: string, body: unknown): Promise<{ status: number; data: any }> {
  const res = await SELF.fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let data: unknown = null
  try {
    data = JSON.parse(text)
  } catch {
    // 纯文本错误响应（textError）不解析，只看状态码
  }
  return { status: res.status, data }
}

async function claim(id: string, attempt: string, extra: Record<string, unknown> = {}) {
  return post('/deliveries/claim', {
    deliveryId: id,
    account: TEST_ADDRESS,
    attemptId: attempt,
    channel: 'layerzero',
    ...extra,
  })
}

describe('POST /deliveries/claim 认领仲裁（第 63 轮桥-3）', () => {
  it('首次认领 201；同 attempt 重认领 200 duplicate（幂等）', async () => {
    const id = deliveryId()
    const first = await claim(id, `${id}#1`)
    expect(first.status).toBe(201)
    expect(first.data.delivery.state).toBe('claimed')
    const again = await claim(id, `${id}#1`)
    expect(again.status).toBe(200)
    expect(again.data.duplicate).toBe(true)
    const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE delivery_id = ?')
      .bind(id)
      .all<{ n: number }>()
    expect(results[0].n).toBe(1)
  })

  it('另一 attempt 认领同笔交付 → 409 delivery_in_flight（跨设备防重复）', async () => {
    const id = deliveryId()
    await claim(id, `${id}#1`)
    const conflict = await claim(id, `${id}#2`)
    expect(conflict.status).toBe(409)
    expect(conflict.data.error).toBe('delivery_in_flight')
    expect(conflict.data.existing.attemptId).toBe(`${id}#1`)
  })

  it('参数校验：坏 deliveryId / 坏 account → 400', async () => {
    const bad1 = await post('/deliveries/claim', { deliveryId: 'nocolon', account: TEST_ADDRESS, attemptId: 'a#1' })
    expect(bad1.status).toBe(400)
    const bad2 = await post('/deliveries/claim', { deliveryId: 't:0xabc', account: 'not-an-address', attemptId: 'a#1' })
    expect(bad2.status).toBe(400)
  })
})

describe('POST /deliveries/report 汇报与状态机', () => {
  it('claim → report initiated（带 hash）→ report delivered；delivered 后新 claim 仍 409', async () => {
    const id = deliveryId()
    await claim(id, `${id}#1`)
    const r1 = await post('/deliveries/report', {
      deliveryId: id, account: TEST_ADDRESS, attemptId: `${id}#1`,
      state: 'initiated', sendTxHash: '0xsend', trackingId: 'guid-1',
    })
    expect(r1.status).toBe(200)
    expect(r1.data.delivery.state).toBe('initiated')
    expect(r1.data.delivery.sendTxHash).toBe('0xsend')
    const r2 = await post('/deliveries/report', {
      deliveryId: id, account: TEST_ADDRESS, attemptId: `${id}#1`, state: 'delivered',
    })
    expect(r2.status).toBe(200)
    expect(r2.data.delivery.state).toBe('delivered')
    const after = await claim(id, `${id}#2`)
    expect(after.status).toBe(409)
  })

  it('旧 attempt 的迟到汇报被拒（attempt mismatch 409），不覆盖新尝试', async () => {
    const id = deliveryId()
    await claim(id, `${id}#1`)
    // 第 63 轮修复批（P1-2）新口径：anomaly 行须带对账 missing 结论才释放
    await post('/deliveries/report', {
      deliveryId: id, account: TEST_ADDRESS, attemptId: `${id}#1`, state: 'anomaly', note: 'failed',
      reconcile: 'missing',
    })
    // anomaly 释放后新尝试重新认领
    const re = await claim(id, `${id}#2`)
    expect(re.status).toBe(200)
    expect(re.data.reclaimed).toBe(true)
    const stale = await post('/deliveries/report', {
      deliveryId: id, account: TEST_ADDRESS, attemptId: `${id}#1`, state: 'delivered',
    })
    expect(stale.status).toBe(409)
    const { data } = await post('/deliveries/claim', {
      deliveryId: id, account: TEST_ADDRESS, attemptId: `${id}#2`,
    })
    expect(data.delivery.state).toBe('claimed')
  })

  it('未认领直接汇报 → 404；非法迁移（claimed → delivered）→ 409', async () => {
    const id = deliveryId()
    const noClaim = await post('/deliveries/report', {
      deliveryId: id, account: TEST_ADDRESS, attemptId: `${id}#1`, state: 'initiated',
    })
    expect(noClaim.status).toBe(404)
    await claim(id, `${id}#1`)
    const badJump = await post('/deliveries/report', {
      deliveryId: id, account: TEST_ADDRESS, attemptId: `${id}#1`, state: 'delivered',
    })
    expect(badJump.status).toBe(409)
  })
})

describe('认领接管（陈旧占位）与查询', () => {
  it('新鲜占位 supersede 也 409；陈旧占位（>30 分钟）supersede 接管成功', async () => {
    const id = deliveryId()
    await claim(id, `${id}#1`)
    const fresh = await claim(id, `${id}#2`, { supersede: true })
    expect(fresh.status).toBe(409)
    // 把占位改陈旧（直接写库模拟时间流逝）
    const staleAt = Math.floor(Date.now() / 1000) - 31 * 60
    await env.DB.prepare('UPDATE deliveries SET updated_at = ? WHERE delivery_id = ?')
      .bind(staleAt, id)
      .run()
    const noSupersede = await claim(id, `${id}#2`)
    expect(noSupersede.status).toBe(409)
    const taken = await claim(id, `${id}#2`, { supersede: true })
    expect(taken.status).toBe(200)
    expect(taken.data.takeover).toBe(true)
    expect(taken.data.delivery.attemptId).toBe(`${id}#2`)
  })

  it('GET 单查与按 account 列表', async () => {
    const id = deliveryId()
    await post('/deliveries/claim', {
      deliveryId: id, account: TEST_ADDRESS_2, attemptId: `${id}#1`, channel: 'ccip',
    })
    const one = await SELF.fetch(`${BASE}/deliveries?deliveryId=${encodeURIComponent(id)}`)
    expect(one.status).toBe(200)
    const row = (await one.json()) as { deliveryId: string; channel: string }
    expect(row.deliveryId).toBe(id)
    expect(row.channel).toBe('ccip')
    const missing = await SELF.fetch(`${BASE}/deliveries?deliveryId=${encodeURIComponent('nope:0xabc')}`)
    expect(missing.status).toBe(404)
    const list = await SELF.fetch(`${BASE}/deliveries?account=${TEST_ADDRESS_2}`)
    expect(list.status).toBe(200)
    const rows = (await list.json()) as Array<{ deliveryId: string }>
    expect(rows.some((r) => r.deliveryId === id)).toBe(true)
  })
})

describe('占位释放收紧（第 63 轮审查修复批 P1-2）', () => {
  it('anomaly 无对账结论 → 再 claim 409；unknown 结论仍 409；missing 结论报备后才可再 claim', async () => {
    const id = deliveryId()
    await claim(id, `${id}#1`)
    // 异常汇报不带任何对账结论
    await post('/deliveries/report', {
      deliveryId: id, account: TEST_ADDRESS, attemptId: `${id}#1`, state: 'anomaly', note: 'boom',
    })
    const noVerdict = await claim(id, `${id}#2`)
    expect(noVerdict.status).toBe(409)
    expect(noVerdict.data.error).toBe('delivery_in_flight')
    // unknown 结论（结果未定）同样不释放
    const unk = await post('/deliveries/report', {
      deliveryId: id, account: TEST_ADDRESS, attemptId: `${id}#1`, state: 'anomaly', reconcile: 'unknown',
    })
    expect(unk.status).toBe(200)
    expect(unk.data.delivery.lastReconcile).toBe('unknown')
    const stillBlocked = await claim(id, `${id}#2`)
    expect(stillBlocked.status).toBe(409)
    // missing 结论（链上对账确认未上链）落行后才放行再 claim，且结论被清
    const miss = await post('/deliveries/report', {
      deliveryId: id, account: TEST_ADDRESS, attemptId: `${id}#1`, state: 'anomaly', reconcile: 'missing',
    })
    expect(miss.status).toBe(200)
    expect(miss.data.delivery.lastReconcile).toBe('missing')
    const re = await claim(id, `${id}#2`)
    expect(re.status).toBe(200)
    expect(re.data.reclaimed).toBe(true)
    expect(re.data.delivery.lastReconcile).toBeNull()
    expect(re.data.delivery.broadcastEvidence).toBe(false)
  })

  it('双发窗口：A 设备广播后报 anomaly（带发送 hash）→ B 设备 claim 与 supersede 均被拒', async () => {
    const id = deliveryId()
    await claim(id, `${id}#1`)
    // A 已广播桥发送、等待回执时失败：anomaly 汇报带广播证据
    const rep = await post('/deliveries/report', {
      deliveryId: id, account: TEST_ADDRESS, attemptId: `${id}#1`, state: 'anomaly',
      sendTxHash: '0xbroadcast', note: 'wait blew up',
    })
    expect(rep.status).toBe(200)
    expect(rep.data.delivery.broadcastEvidence).toBe(true)
    // B 设备（新 attempt）普通 claim 被拒
    const bClaim = await claim(id, `${id}#2`)
    expect(bClaim.status).toBe(409)
    // B 带 supersede 也被拒（anomaly 行只认 missing 结论，不走接管）
    const bSupersede = await claim(id, `${id}#2`, { supersede: true })
    expect(bSupersede.status).toBe(409)
    // 行保持 A 的 attempt 与证据，不被覆盖
    const one = await SELF.fetch(`${BASE}/deliveries?deliveryId=${encodeURIComponent(id)}`)
    const row = (await one.json()) as { attemptId: string; sendTxHash: string; broadcastEvidence: boolean }
    expect(row.attemptId).toBe(`${id}#1`)
    expect(row.sendTxHash).toBe('0xbroadcast')
    expect(row.broadcastEvidence).toBe(true)
  })

  it('supersede 接管新增零广播证据要求：initiated 行陈旧但有发送 hash → 永不接管', async () => {
    const id = deliveryId()
    await claim(id, `${id}#1`)
    await post('/deliveries/report', {
      deliveryId: id, account: TEST_ADDRESS, attemptId: `${id}#1`, state: 'initiated',
      sendTxHash: '0xsend', trackingId: 'guid-1',
    })
    const staleAt = Math.floor(Date.now() / 1000) - 31 * 60
    await env.DB.prepare('UPDATE deliveries SET updated_at = ? WHERE delivery_id = ?')
      .bind(staleAt, id)
      .run()
    const taken = await claim(id, `${id}#2`, { supersede: true })
    expect(taken.status).toBe(409)
    const one = await SELF.fetch(`${BASE}/deliveries?deliveryId=${encodeURIComponent(id)}`)
    const row = (await one.json()) as { attemptId: string; state: string }
    expect(row.attemptId).toBe(`${id}#1`)
    expect(row.state).toBe('initiated')
  })

  it('零广播证据的悬空 claimed 行陈旧后 supersede 仍可接管（正路不堵）', async () => {
    const id = deliveryId()
    await claim(id, `${id}#1`)
    const staleAt = Math.floor(Date.now() / 1000) - 31 * 60
    await env.DB.prepare('UPDATE deliveries SET updated_at = ? WHERE delivery_id = ?')
      .bind(staleAt, id)
      .run()
    const taken = await claim(id, `${id}#2`, { supersede: true })
    expect(taken.status).toBe(200)
    expect(taken.data.takeover).toBe(true)
  })

  it('显式 broadcastEvidence 标记（无 hash）同样锁死接管与释放', async () => {
    const id = deliveryId()
    await claim(id, `${id}#1`)
    await post('/deliveries/report', {
      deliveryId: id, account: TEST_ADDRESS, attemptId: `${id}#1`, state: 'initiated',
      broadcastEvidence: true,
    })
    const staleAt = Math.floor(Date.now() / 1000) - 31 * 60
    await env.DB.prepare('UPDATE deliveries SET updated_at = ? WHERE delivery_id = ?')
      .bind(staleAt, id)
      .run()
    const taken = await claim(id, `${id}#2`, { supersede: true })
    expect(taken.status).toBe(409)
  })
})
