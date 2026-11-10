/**
 * 第 59 轮审查修复批 P1 故障注入：投递结果不确定（中继已入库但响应
 * 丢失）时不得 release 每日预留。
 *
 * 旧实现：postOrder 抛错一律当投递失败 release——订单实际已在簿上，
 * 预留却被退还，活单零成本。本文件用有状态假中继逐条钉住新语义：
 * - 入库后丢响应 → 对账命中 → 成功返回（deliveryReconciled）、预留保留；
 * - 明确 HTTP 400 → relay_rejected、预留回滚；
 * - 不可达且对账确认未入库 → 原错误上抛、预留回滚；
 * - 对账本身失败 → delivery_ambiguous、预留保留（fail-closed）；
 * match_order 的投递路径同口径各验一条。
 *
 * 假中继的 digest 用与生产同一份前端摘要代码（buildSignedOrderData +
 * computeOrderDigest）从投递 body 重建——与真中继的服务端重建同值，
 * 对账比对走的是生产比对逻辑本身，不是测试自备的假摘要。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetSignerCache, _setKeyTextProvider } from '../src/signers'
import type { ToolDef } from '../src/tools/common'
import { matchTools } from '../src/tools/match'
import { writeTools } from '../src/tools/write'
import { FakeChainReader, jsonResponse, makeCtx } from './helpers'
import type { FetchFn } from '../src/relay'

// —— 前端生产代码（与被测投递路径同一份摘要实现）——
import {
  buildSignedOrderData,
  computeOrderDigest,
} from '../../frontend/src/services/dualread/digest'
import type { RawOrder } from '../../frontend/src/services/dualread/types'

// 撮合引擎用替身：本文件只测投递/记账，不测撮合本身
vi.mock('../../frontend/src/services/matching/execute', () => ({
  executeFrontendMatch: vi.fn(),
}))
import { executeFrontendMatch } from '../../frontend/src/services/matching/execute'
const matchMock = vi.mocked(executeFrontendMatch)

// 公开的 Anvil/Hardhat 文档测试钥（账号 #0），与 guard-accounting.test.ts 同一把
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

type PostMode = 'ok' | 'store-drop' | 'reject400' | 'drop'

/**
 * 有状态假中继：
 * - 'ok'：入库并回 200；'store-drop'：入库后抛错（响应丢失）；
 * - 'reject400'：明确拒单不入库；'drop'：抛错且不入库（不可达）。
 * GET /orders 返回已入库行（对账面）；getFails 时 GET 也抛错。
 */
class AmbiguousRelay {
  stored: Record<string, unknown>[] = []
  postMode: PostMode = 'ok'
  getFails = false
  posts = 0

  fetchFn: FetchFn = async (_url, init) => {
    if (init?.method === 'POST') {
      this.posts++
      if (this.postMode === 'reject400') {
        return jsonResponse({ error: 'bad order' }, 400)
      }
      if (this.postMode === 'drop') {
        throw new Error('network unreachable')
      }
      const body = JSON.parse(String(init.body)) as RawOrder & { chainId: number }
      const data = buildSignedOrderData(body, body.chainId)
      const digest = data ? computeOrderDigest(data, body.chainId) : '0x' + '00'.repeat(32)
      this.stored.push({ ...body, digest })
      if (this.postMode === 'store-drop') {
        throw new Error('response lost in transit')
      }
      return jsonResponse({ ok: true, digest })
    }
    if (this.getFails) throw new Error('relay read path down')
    return jsonResponse(this.stored)
  }
}

function tool(tools: ToolDef[], name: string): ToolDef {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`missing tool ${name}`)
  return t
}

const PLACE_ARGS = { chainId: 11155111, pair: 'TKA/TKB', side: 'sell', price: '2', amount: '1' }

beforeEach(() => {
  matchMock.mockReset()
  _setKeyTextProvider(() => ANVIL_KEY)
})

afterEach(() => {
  _setKeyTextProvider(null)
  _resetSignerCache()
  delete process.env.BIT100_MCP_KILL_SWITCH
})

function setup(relay: AmbiguousRelay) {
  // capped-test：单笔上限 2、日限 5——每笔名义额 2，两笔占 4，第三笔必超
  const { ctx } = makeCtx({
    agentId: 'capped-test',
    chain: new NonceChainReader(),
    fetchFn: relay.fetchFn,
  })
  return ctx
}

describe('place_order 投递对账（修复批 P1）', () => {
  it('中继入库后响应丢失 → 对账命中：成功返回 deliveryReconciled 且预留保留', async () => {
    const relay = new AmbiguousRelay()
    relay.postMode = 'store-drop'
    const ctx = setup(relay)
    const place = tool(writeTools, 'place_order')

    const out = (await place.handler(ctx, PLACE_ARGS)) as {
      relayStatus: number
      deliveryReconciled?: boolean
      digest: string
    }
    expect(out.relayStatus).toBe(200)
    expect(out.deliveryReconciled).toBe(true)
    expect(relay.stored.map((o) => o.digest)).toContain(out.digest)

    // 预留保留的证据：再成功一笔（合计 4），第三笔 over_daily_cap。
    // 若对账命中时错误地 release 了预留，第三笔会放行（2+2 ≤ 5）。
    relay.postMode = 'ok'
    await expect(place.handler(ctx, PLACE_ARGS)).resolves.toMatchObject({ relayStatus: 200 })
    await expect(place.handler(ctx, PLACE_ARGS)).rejects.toMatchObject({ code: 'over_daily_cap' })
  })

  it('中继明确拒单 400 → relay_rejected 且预留回滚', async () => {
    const relay = new AmbiguousRelay()
    relay.postMode = 'reject400'
    const ctx = setup(relay)
    const place = tool(writeTools, 'place_order')

    await expect(place.handler(ctx, PLACE_ARGS)).rejects.toMatchObject({ code: 'relay_rejected' })
    await expect(place.handler(ctx, PLACE_ARGS)).rejects.toMatchObject({ code: 'relay_rejected' })
    expect(relay.stored).toHaveLength(0)

    // 两笔被拒没占额度：接下来两笔可成功（合计 4），第三笔才超限
    relay.postMode = 'ok'
    await expect(place.handler(ctx, PLACE_ARGS)).resolves.toMatchObject({ relayStatus: 200 })
    await expect(place.handler(ctx, PLACE_ARGS)).resolves.toMatchObject({ relayStatus: 200 })
    await expect(place.handler(ctx, PLACE_ARGS)).rejects.toMatchObject({ code: 'over_daily_cap' })
  })

  it('中继不可达且对账确认未入库 → relay_unreachable 上抛且预留回滚', async () => {
    const relay = new AmbiguousRelay()
    relay.postMode = 'drop'
    const ctx = setup(relay)
    const place = tool(writeTools, 'place_order')

    await expect(place.handler(ctx, PLACE_ARGS)).rejects.toMatchObject({ code: 'relay_unreachable' })
    await expect(place.handler(ctx, PLACE_ARGS)).rejects.toMatchObject({ code: 'relay_unreachable' })
    expect(relay.stored).toHaveLength(0)

    relay.postMode = 'ok'
    await expect(place.handler(ctx, PLACE_ARGS)).resolves.toMatchObject({ relayStatus: 200 })
  })

  it('已入库但对账查询也失败 → delivery_ambiguous 且预留保留（fail-closed）', async () => {
    const relay = new AmbiguousRelay()
    relay.postMode = 'store-drop'
    relay.getFails = true
    const ctx = setup(relay)
    const place = tool(writeTools, 'place_order')

    await expect(place.handler(ctx, PLACE_ARGS)).rejects.toMatchObject({
      code: 'delivery_ambiguous',
    })
    expect(relay.stored).toHaveLength(1) // 订单实际在簿——这正是不能退款的原因

    // 预留保留的证据：对账恢复后成功一笔（合计 4），再下一笔超限。
    // 若失败路径退了预留，此时应能连下两笔。
    relay.getFails = false
    relay.postMode = 'ok'
    await expect(place.handler(ctx, PLACE_ARGS)).resolves.toMatchObject({ relayStatus: 200 })
    await expect(place.handler(ctx, PLACE_ARGS)).rejects.toMatchObject({ code: 'over_daily_cap' })
  })
})

describe('match_order 投递对账（修复批 P1，同口径）', () => {
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

  it('入库后响应丢失 → 对账命中后照常撮合并记账（预留保留）', async () => {
    const relay = new AmbiguousRelay()
    relay.postMode = 'store-drop'
    const ctx = setup(relay)
    const match = tool(matchTools, 'match_order')
    matchMock.mockResolvedValue(submitted as never)

    const out = (await match.handler(ctx, PLACE_ARGS)) as {
      status: string
      deliveryReconciled?: boolean
    }
    expect(out.status).toBe('submitted')
    expect(out.deliveryReconciled).toBe(true)

    relay.postMode = 'ok'
    await expect(match.handler(ctx, PLACE_ARGS)).resolves.toMatchObject({ status: 'submitted' })
    await expect(match.handler(ctx, PLACE_ARGS)).rejects.toMatchObject({ code: 'over_daily_cap' })
    expect(relay.posts).toBe(2)
  })

  it('已入库但对账失败 → delivery_ambiguous，撮合不启动、预留保留', async () => {
    const relay = new AmbiguousRelay()
    relay.postMode = 'store-drop'
    relay.getFails = true
    const ctx = setup(relay)
    const match = tool(matchTools, 'match_order')
    matchMock.mockResolvedValue(submitted as never)

    await expect(match.handler(ctx, PLACE_ARGS)).rejects.toMatchObject({
      code: 'delivery_ambiguous',
    })
    expect(matchMock).not.toHaveBeenCalled()
  })
})
