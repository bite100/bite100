/**
 * 前端撮合灰度开关口径回归（第 45 轮 A3）：VITE_FRONTEND_MATCHING
 * 缺省与任何非 on 值一律关——关时下单走开启前的既有节点路径
 * （广播 → 节点撮合 → 节点提交），这是切换的回滚点；只有
 * on/true/1（去空格、大小写不敏感）才开。开关的下单侧消费点在
 * LimitOrderFormWidget（广播成功后才读开关决定是否本机撮合），
 * 广播层本身不读开关（orderService 不 import 本模块），故开关
 * 开/关不改变广播语义——该不变量由 orderBroadcast.test.ts 覆盖。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

async function loadEnabled(value: string | undefined): Promise<boolean> {
  vi.resetModules()
  vi.stubEnv('VITE_FRONTEND_MATCHING', value ?? '')
  const m = await import('./matching')
  return m.FRONTEND_MATCHING_ENABLED
}

describe('FRONTEND_MATCHING_ENABLED 开关口径', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('未设置（缺省）→ 关（下单行为与开启前一致）', async () => {
    await expect(loadEnabled(undefined)).resolves.toBe(false)
  })

  it.each([['off'], ['false'], ['0'], ['garbage'], ['onn'], ['yes']])(
    '非 on 值 %s → 关',
    async (v) => {
      await expect(loadEnabled(v)).resolves.toBe(false)
    },
  )

  it.each([['on'], ['true'], ['1'], [' ON '], ['True']])(
    '开启值 %s → 开',
    async (v) => {
      await expect(loadEnabled(v)).resolves.toBe(true)
    },
  )
})
