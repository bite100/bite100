import { describe, expect, it } from 'vitest'
import { readTools } from '../src/tools/read'
import type { ToolDef } from '../src/tools/common'
import { DIGEST, MAKER_ADDR, makeCtx } from './helpers'

function tool(name: string): ToolDef {
  const t = readTools.find((x) => x.name === name)
  if (!t) throw new Error(`missing tool ${name}`)
  return t
}

describe('只读工具（mock 中继 + mock 链读）', () => {
  it('get_chain_config 返回第 62 轮栈地址', async () => {
    const { ctx } = makeCtx()
    const out = (await tool('get_chain_config').handler(ctx, { chainId: 84532 })) as {
      settlement: string
    }
    expect(out.settlement).toBe('0x4969b9ACBe7Dbf57E150FcF413B622c2912e2e97')
  })

  it('get_chain_config 拒绝主网 chainId', async () => {
    const { ctx } = makeCtx()
    await expect(tool('get_chain_config').handler(ctx, { chainId: 1 })).rejects.toMatchObject({
      code: 'chain_not_allowed',
    })
  })

  it('get_orderbook 返回中继簿并裁剪 depth', async () => {
    const { ctx } = makeCtx()
    const out = (await tool('get_orderbook').handler(ctx, {
      chainId: 11155111,
      pair: 'TKA/TKB',
      depth: 5,
    })) as { asks: unknown[] }
    expect(out.asks).toHaveLength(1)
  })

  it('get_orderbook 拒绝白名单外交易对', async () => {
    const { ctx } = makeCtx()
    await expect(
      tool('get_orderbook').handler(ctx, { chainId: 11155111, pair: 'PEPE/USDT' }),
    ).rejects.toMatchObject({ code: 'pair_not_allowed' })
  })

  it('list_orders 透传中继结果', async () => {
    const { ctx } = makeCtx()
    const out = (await tool('list_orders').handler(ctx, {
      chainId: 11155111,
      userAddress: MAKER_ADDR,
    })) as { count: number }
    expect(out.count).toBe(1)
  })

  it('list_orders 参数非法（坏地址）→ invalid_params', async () => {
    const { ctx } = makeCtx()
    await expect(
      tool('list_orders').handler(ctx, { chainId: 11155111, userAddress: 'not-an-address' }),
    ).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('get_balances 汇总原生币与代币（钱包/Vault/可用）', async () => {
    const { ctx } = makeCtx()
    const out = (await tool('get_balances').handler(ctx, {
      chainId: 11155111,
      address: MAKER_ADDR,
    })) as {
      native: { human: string }
      tokens: Record<string, { wallet: { human: string }; vaultAvailable: { human: string } }>
    }
    expect(out.native.human).toBe('1.0')
    expect(out.tokens.TKA.wallet.human).toBe('500.0')
    expect(out.tokens.TKA.vaultAvailable.human).toBe('90.0')
    expect(out.tokens.USDT).toBeDefined()
  })

  it('get_order_status 汇总成交/锁定/墓碑', async () => {
    const { ctx, chain } = makeCtx()
    chain.filled = 250000000000000000n
    chain.lock = {
      user: MAKER_ADDR,
      token: '0x93a4af54d7cd8af7c9aef50d3dd3977ba1dde28e',
      remaining: '250000000000000000',
      expiresAt: 1700003600,
    }
    const out = (await tool('get_order_status').handler(ctx, {
      chainId: 11155111,
      digest: DIGEST,
    })) as { filledIn: { human: string }; locked: boolean; cancelled: boolean }
    expect(out.filledIn.human).toBe('0.25')
    expect(out.locked).toBe(true)
    expect(out.cancelled).toBe(false)
  })
})
