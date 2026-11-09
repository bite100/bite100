import { afterEach, describe, expect, it } from 'vitest'
import { writeTools } from '../src/tools/write'
import type { ToolDef } from '../src/tools/common'
import { DIGEST, FakeChainReader, makeCtx } from './helpers'

function tool(name: string): ToolDef {
  const t = writeTools.find((x) => x.name === name)
  if (!t) throw new Error(`missing tool ${name}`)
  return t
}

const place = (ctx: Parameters<ToolDef['handler']>[0], args: Record<string, unknown>) =>
  tool('place_order').handler(ctx, args)

describe('place_order 护栏先行（拒绝发生在任何链/中继副作用之前）', () => {
  afterEach(() => {
    delete process.env.BIT100_MCP_KILL_SWITCH
  })

  it('主网 chainId → chain_not_allowed', async () => {
    const { ctx } = makeCtx()
    await expect(
      place(ctx, { chainId: 1, pair: 'TKA/TKB', side: 'sell', price: '1.5', amount: '0.5' }),
    ).rejects.toMatchObject({ code: 'chain_not_allowed' })
  })

  it('白名单外交易对 → pair_not_allowed', async () => {
    const { ctx } = makeCtx()
    await expect(
      place(ctx, { chainId: 11155111, pair: 'PEPE/USDT', side: 'sell', price: '1.5', amount: '0.5' }),
    ).rejects.toMatchObject({ code: 'pair_not_allowed' })
  })

  it('超单笔上限 → over_per_order_cap', async () => {
    const { ctx } = makeCtx({ agentId: 'capped-test' }) // 单笔上限 2
    await expect(
      place(ctx, { chainId: 11155111, pair: 'TKA/TKB', side: 'sell', price: '3', amount: '1' }),
    ).rejects.toMatchObject({ code: 'over_per_order_cap' })
  })

  it('停用 agent → agent_disabled', async () => {
    const { ctx } = makeCtx({ agentId: 'disabled-test' })
    await expect(
      place(ctx, { chainId: 11155111, pair: 'TKA/TKB', side: 'buy', price: '1.5', amount: '0.5' }),
    ).rejects.toMatchObject({ code: 'agent_disabled' })
  })

  it('全局急停 → kill_switch_on', async () => {
    process.env.BIT100_MCP_KILL_SWITCH = '1'
    const { ctx } = makeCtx()
    await expect(
      place(ctx, { chainId: 11155111, pair: 'TKA/TKB', side: 'sell', price: '1.5', amount: '0.5' }),
    ).rejects.toMatchObject({ code: 'kill_switch_on' })
  })

  it('数量为 0 / 负数 → invalid_params（schema 层）', async () => {
    const { ctx } = makeCtx()
    await expect(
      place(ctx, { chainId: 11155111, pair: 'TKA/TKB', side: 'sell', price: '1.5', amount: '0' }),
    ).rejects.toMatchObject({ code: 'invalid_params' })
  })
})

describe('hard_cancel_order 撤单面口径', () => {
  it('未落锁订单 → 如实返回 no_active_lock 缺口（不假装撤销）', async () => {
    const { ctx } = makeCtx()
    const out = (await tool('hard_cancel_order').handler(ctx, {
      chainId: 11155111,
      digest: DIGEST,
    })) as { cancelled: boolean; reason?: string; explanation?: string }
    expect(out.cancelled).toBe(false)
    expect(out.reason).toBe('no_active_lock')
    expect(out.explanation).toContain('中继没有撤单路由')
  })

  it('已置墓碑 → cancelled:true（幂等）', async () => {
    const chain = new FakeChainReader()
    chain.cancelled = true
    const { ctx } = makeCtx({ chain })
    const out = (await tool('hard_cancel_order').handler(ctx, {
      chainId: 11155111,
      digest: DIGEST,
    })) as { cancelled: boolean; alreadyCancelled?: boolean }
    expect(out.cancelled).toBe(true)
    expect(out.alreadyCancelled).toBe(true)
  })

  it('急停时撤单同样被拒', async () => {
    process.env.BIT100_MCP_KILL_SWITCH = '1'
    try {
      const { ctx } = makeCtx()
      await expect(
        tool('hard_cancel_order').handler(ctx, { chainId: 11155111, digest: DIGEST }),
      ).rejects.toMatchObject({ code: 'kill_switch_on' })
    } finally {
      delete process.env.BIT100_MCP_KILL_SWITCH
    }
  })
})
