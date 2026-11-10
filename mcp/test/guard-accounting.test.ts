/**
 * 第 59 轮验收：记账时点（stdio 路径，WriteGuard + 真实工具 handler）。
 *
 * 旧协议（第 57 轮）的洞：record 只在成功尾部调用——
 * - match_order 只在 outcome=submitted 时记账，未成交单零成本（P1-①）；
 * - place_order 被中继拒收、hard_cancel 的提前返回/抛错路径都不落
 *   频率事件，失败尝试可以无限刷 RPC（审计 ⑥）。
 * 新协议：check 即预留（频率当场落账、每日名义额当场计入），中继
 * 接受后不回滚，投递失败只回滚每日预留。本文件逐条钉住新口径；
 * D1 后端的同构验收在 worker-state.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetSignerCache, _setKeyTextProvider } from '../src/signers'
import type { ToolDef } from '../src/tools/common'
import { matchTools } from '../src/tools/match'
import { writeTools } from '../src/tools/write'
import { DIGEST, FakeChainReader, jsonResponse, makeCtx } from './helpers'
import type { FetchFn } from '../src/relay'

// 撮合引擎用替身：本文件只测记账，不测撮合本身（撮合由前端自有测试覆盖）
vi.mock('../../frontend/src/services/matching/execute', () => ({
  executeFrontendMatch: vi.fn(),
}))
import { executeFrontendMatch } from '../../frontend/src/services/matching/execute'
const matchMock = vi.mocked(executeFrontendMatch)

// 公开的 Anvil/Hardhat 文档测试钥（账号 #0），与 signers.test.ts 同一把
const ANVIL_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4' + 'f2ff80'

/** 能应付 Settlement.getCurrentNonce 静态调用的 provider 替身 */
const stubProvider = {
  call: async () => '0x' + '0'.repeat(64),
  getNetwork: async () => ({ chainId: 11155111n, name: 'sepolia' }),
  getBlockNumber: async () => 1,
}

class NonceChainReader extends FakeChainReader {
  override provider(): never {
    return stubProvider as unknown as never
  }
}

function relayStub(status: () => number) {
  let posts = 0
  const fetchFn: FetchFn = async (_url, init) => {
    if (init?.method === 'POST') {
      posts++
      const s = status()
      return jsonResponse({ ok: s === 200 }, s)
    }
    return jsonResponse({ error: 'not found' }, 404)
  }
  return { fetchFn, posts: () => posts }
}

function tool(tools: ToolDef[], name: string): ToolDef {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`missing tool ${name}`)
  return t
}

const PLACE_ARGS = { chainId: 11155111, pair: 'TKA/TKB', side: 'sell', price: '2', amount: '1' }

let keyLoads = 0

beforeEach(() => {
  keyLoads = 0
  matchMock.mockReset()
  _setKeyTextProvider(() => {
    keyLoads++
    return ANVIL_KEY
  })
})

afterEach(() => {
  _setKeyTextProvider(null)
  _resetSignerCache()
  delete process.env.BIT100_MCP_KILL_SWITCH
})

describe('place_order 记账时点', () => {
  it('中继接受 → 每日额度当场消耗（两笔 2/日限 5 后第三笔 over_daily_cap）', async () => {
    const relay = relayStub(() => 200)
    const { ctx } = makeCtx({ agentId: 'capped-test', chain: new NonceChainReader(), fetchFn: relay.fetchFn })
    const place = tool(writeTools, 'place_order')
    await place.handler(ctx, PLACE_ARGS)
    await place.handler(ctx, PLACE_ARGS)
    await expect(place.handler(ctx, PLACE_ARGS)).rejects.toMatchObject({ code: 'over_daily_cap' })
    expect(relay.posts()).toBe(2) // 第三笔在护栏层就被拒，没到中继
  })

  it('中继拒收 → 每日预留回滚（两笔被拒后第三笔仍可成功），但频率照常消耗', async () => {
    let status = 500
    const relay = relayStub(() => status)
    const { ctx } = makeCtx({ agentId: 'capped-test', chain: new NonceChainReader(), fetchFn: relay.fetchFn })
    const place = tool(writeTools, 'place_order')
    await expect(place.handler(ctx, PLACE_ARGS)).rejects.toMatchObject({ code: 'relay_rejected' })
    await expect(place.handler(ctx, PLACE_ARGS)).rejects.toMatchObject({ code: 'relay_rejected' })
    status = 200
    // 若被拒的两笔也占了每日额度（2+2），这笔会因 4+2>5 被 over_daily_cap
    await expect(place.handler(ctx, PLACE_ARGS)).resolves.toMatchObject({ relayStatus: 200 })
  })

  it('失败尝试消耗频率：maker（3/分钟）三笔被中继拒收后，第四笔 rate_limited 且不再投递', async () => {
    const relay = relayStub(() => 500)
    const { ctx } = makeCtx({ agentId: 'maker-test', chain: new NonceChainReader(), fetchFn: relay.fetchFn })
    const place = tool(writeTools, 'place_order')
    for (let i = 0; i < 3; i++) {
      await expect(place.handler(ctx, PLACE_ARGS)).rejects.toMatchObject({ code: 'relay_rejected' })
    }
    await expect(place.handler(ctx, PLACE_ARGS)).rejects.toMatchObject({ code: 'rate_limited' })
    expect(relay.posts()).toBe(3)
  })

  it('签名器未配置 → 投递前失败，每日预留回滚（配好钥后同额可成功）', async () => {
    _setKeyTextProvider(() => null)
    const relay = relayStub(() => 200)
    const { ctx } = makeCtx({ agentId: 'capped-test', chain: new NonceChainReader(), fetchFn: relay.fetchFn })
    const place = tool(writeTools, 'place_order')
    await expect(place.handler(ctx, PLACE_ARGS)).rejects.toMatchObject({ code: 'signer_not_configured' })
    await expect(place.handler(ctx, PLACE_ARGS)).rejects.toMatchObject({ code: 'signer_not_configured' })
    expect(relay.posts()).toBe(0)
    _setKeyTextProvider(() => ANVIL_KEY)
    await expect(place.handler(ctx, PLACE_ARGS)).resolves.toMatchObject({ relayStatus: 200 })
  })

  it('急停/停用 → 不加载签名钥、不投递（验收 ④：无未授权签名）', async () => {
    const relay = relayStub(() => 200)
    const place = tool(writeTools, 'place_order')

    const disabled = makeCtx({ agentId: 'disabled-test', chain: new NonceChainReader(), fetchFn: relay.fetchFn })
    await expect(place.handler(disabled.ctx, PLACE_ARGS)).rejects.toMatchObject({ code: 'agent_disabled' })

    process.env.BIT100_MCP_KILL_SWITCH = '1'
    const killed = makeCtx({ agentId: 'maker-test', chain: new NonceChainReader(), fetchFn: relay.fetchFn })
    await expect(place.handler(killed.ctx, PLACE_ARGS)).rejects.toMatchObject({ code: 'kill_switch_on' })

    expect(keyLoads).toBe(0) // 签名器从未被加载 = 从未签名
    expect(relay.posts()).toBe(0)
  })
})

describe('match_order 记账时点（P1-① 本体）', () => {
  const submitted = {
    status: 'submitted' as const,
    message: 'ok',
    txHash: '0x' + '12'.repeat(32),
    legsKept: 1,
    legsPruned: 0,
    legsOverflow: 0,
    filledToken0: '1',
    remainderToken0: '0',
  }
  const noMatch = {
    status: 'no-match' as const,
    message: 'no match',
    legsKept: 0,
    legsPruned: 0,
    legsOverflow: 0,
    filledToken0: '0',
    remainderToken0: '1',
  }

  it(
    '未成交（no-match）同样记账：no-match + submitted 各一笔后，第三笔 over_daily_cap',
    async () => {
      const relay = relayStub(() => 200)
      const { ctx } = makeCtx({ agentId: 'capped-test', chain: new NonceChainReader(), fetchFn: relay.fetchFn })
      const match = tool(matchTools, 'match_order')
      matchMock.mockResolvedValueOnce(noMatch as never).mockResolvedValue(noMatch as never)
      // 第一笔 no-match：handler 内部等 10 秒重试窗口后仍 no-match（真实计时）
      const out1 = (await match.handler(ctx, PLACE_ARGS)) as { status: string }
      expect(out1.status).toBe('no-match')
      matchMock.mockResolvedValue(submitted as never)
      const out2 = (await match.handler(ctx, PLACE_ARGS)) as { status: string }
      expect(out2.status).toBe('submitted')
      // 两笔各 2、日限 5：旧实现下 no-match 不记账，第三笔本应放行
      await expect(match.handler(ctx, PLACE_ARGS)).rejects.toMatchObject({ code: 'over_daily_cap' })
      expect(relay.posts()).toBe(2)
    },
    60_000,
  )

  it('中继拒收 → 每日预留回滚：两笔被拒后改 200 仍可成功', async () => {
    let status = 500
    const relay = relayStub(() => status)
    const { ctx } = makeCtx({ agentId: 'capped-test', chain: new NonceChainReader(), fetchFn: relay.fetchFn })
    const match = tool(matchTools, 'match_order')
    matchMock.mockResolvedValue(submitted as never)
    await expect(match.handler(ctx, PLACE_ARGS)).rejects.toMatchObject({ code: 'relay_rejected' })
    await expect(match.handler(ctx, PLACE_ARGS)).rejects.toMatchObject({ code: 'relay_rejected' })
    status = 200
    const out = (await match.handler(ctx, PLACE_ARGS)) as { status: string }
    expect(out.status).toBe('submitted')
  })
})

describe('hard_cancel_order 频率记账（审计 ⑥）', () => {
  it('no_active_lock 提前返回同样计频率：maker 第 4 次调用 rate_limited', async () => {
    const { ctx } = makeCtx({ agentId: 'maker-test' }) // 频率 3/分钟；缺省链替身无锁
    const cancel = tool(writeTools, 'hard_cancel_order')
    for (let i = 0; i < 3; i++) {
      const out = (await cancel.handler(ctx, { chainId: 11155111, digest: DIGEST })) as { reason?: string }
      expect(out.reason).toBe('no_active_lock')
    }
    await expect(cancel.handler(ctx, { chainId: 11155111, digest: DIGEST })).rejects.toMatchObject({
      code: 'rate_limited',
    })
  })

  it('alreadyCancelled 提前返回同样计频率', async () => {
    const chain = new FakeChainReader()
    chain.cancelled = true
    const { ctx } = makeCtx({ agentId: 'maker-test', chain })
    const cancel = tool(writeTools, 'hard_cancel_order')
    for (let i = 0; i < 3; i++) {
      const out = (await cancel.handler(ctx, { chainId: 11155111, digest: DIGEST })) as { alreadyCancelled?: boolean }
      expect(out.alreadyCancelled).toBe(true)
    }
    await expect(cancel.handler(ctx, { chainId: 11155111, digest: DIGEST })).rejects.toMatchObject({
      code: 'rate_limited',
    })
  })
})
