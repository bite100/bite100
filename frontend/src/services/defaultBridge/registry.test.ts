import { describe, it, expect } from 'vitest'
import { createHttpRegistry, RegistryConflictError, RegistryUnavailableError } from './registry'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const ROW = {
  deliveryId: 't1:0xabc',
  account: '0xabc',
  state: 'claimed',
  attemptId: 't1:0xabc#1.x',
  channel: 'layerzero',
  sendTxHash: null,
  trackingId: null,
  note: null,
  createdAt: 1,
  updatedAt: 1,
}

describe('交付登记 HTTP 客户端（第 63 轮桥-3）', () => {
  it('claim 201 → 返回登记行与标志', async () => {
    const registry = createHttpRegistry('https://relay.example', async () =>
      jsonResponse(201, { ok: true, delivery: ROW, duplicate: false, takeover: false, reclaimed: false })
    )
    const out = await registry.claim({ deliveryId: 't1:0xabc', account: '0xabc', attemptId: 't1:0xabc#1.x' })
    expect(out.row.state).toBe('claimed')
    expect(out.duplicate).toBe(false)
  })

  it('claim 409 → RegistryConflictError 并带既有登记', async () => {
    const registry = createHttpRegistry('https://relay.example', async () =>
      jsonResponse(409, { ok: false, error: 'delivery_in_flight', message: 'delivery already in flight', existing: ROW })
    )
    await expect(
      registry.claim({ deliveryId: 't1:0xabc', account: '0xabc', attemptId: 't1:0xabc#2.y' })
    ).rejects.toBeInstanceOf(RegistryConflictError)
  })

  it('中继未配置（空基地址）→ claim 直接 RegistryUnavailableError（fail-closed）', async () => {
    const registry = createHttpRegistry('', async () => {
      throw new Error('不应发请求')
    })
    await expect(
      registry.claim({ deliveryId: 't1:0xabc', account: '0xabc', attemptId: 'a#1' })
    ).rejects.toBeInstanceOf(RegistryUnavailableError)
  })

  it('fetch 抛错（不可达）→ claim RegistryUnavailableError；get/list 降级为空', async () => {
    const registry = createHttpRegistry('https://relay.example', async () => {
      throw new Error('network down')
    })
    await expect(
      registry.claim({ deliveryId: 't1:0xabc', account: '0xabc', attemptId: 'a#1' })
    ).rejects.toBeInstanceOf(RegistryUnavailableError)
    await expect(registry.get('t1:0xabc')).resolves.toBeNull()
    await expect(registry.listByAccount('0xabc')).resolves.toEqual([])
  })

  it('report 非 2xx 抛普通错误（调用方 best-effort 吞掉）', async () => {
    const registry = createHttpRegistry('https://relay.example', async () => jsonResponse(409, { ok: false }))
    await expect(
      registry.report({ deliveryId: 't1:0xabc', account: '0xabc', attemptId: 'a#1', state: 'initiated' })
    ).rejects.toThrow('HTTP 409')
  })
})
