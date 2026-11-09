/**
 * createTestIndexer 合成事件测试（Envio 官方测试库；无账号、simulate 模式不联网取数）：
 * 喂合成事件进真实 handler，断言实体落库结果——
 * - 批量 tx 两笔成交不重不漏、ID 按 chainId-txHash-logIndex；
 * - digest 经 transaction.input 解码按序关联；
 * - GasCostShared 按序 + maker/taker 双核对挂到第一笔成交；
 * - 双链同 txHash/序号的实体互不串扰（per-chain 模式）。
 *
 * 注意：这是合成事件测试，不是真实链数据 E2E（真实回放见 reconcile.test.ts，
 * 真实 HyperSync 同步 E2E 需要 ENVIO_API_TOKEN / Envio Cloud，属部署阶段）。
 */
import { describe, it, expect } from 'vitest'
import { createTestIndexer } from 'envio'
import { encodeFunctionData } from 'viem'
import { SETTLEMENT_WRITE_ABI } from '../src/lib/settlementAbi'
import { orderDigest, tradeEntityId, type DecodedOrder } from '../src/lib/association'

const SEPOLIA = 11155111
const BASE = 84532
const SETTLEMENT: Record<number, `0x${string}`> = {
  [SEPOLIA]: '0x5697F7B2178352eB391e29fc2c5681Dea864C1d9',
  [BASE]: '0x1021C7116cCE59f9c85683d6f1b5aD2215795949',
}
const MAKER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const TAKER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const T_IN = '0x1111111111111111111111111111111111111111'
const T_OUT = '0x2222222222222222222222222222222222222222'
const TX = `0x${'cd'.repeat(32)}`

// 阶段 3 切换：DecodedOrder 新增 side（默认 1=sell，maker 口径）；
// calldata 由 encodeFunctionData 按新 ABI 运行时构造，无旧夹具需重生成。
function order(id: string, user: string, nonce: bigint, side = 1): DecodedOrder {
  return {
    orderId: id,
    userAddress: user,
    tokenIn: T_IN,
    tokenOut: T_OUT,
    amountIn: 100000000000000000000n,
    amountOut: 200000000000000000000n,
    price: 2000000000000000000n,
    timestamp: 1700000000n,
    expiresAt: 1700086400n,
    nonce,
    side,
  }
}

function batchCalldata(): string {
  const fills = [0n, 1n].map((n) => ({
    makerOrder: { order: order(`m${n}`, MAKER, n, 1), signature: '0x1234' as `0x${string}` },
    takerOrder: { order: order(`t${n}`, TAKER, n, 0), signature: '0x5678' as `0x${string}` },
    tokenIn: T_IN,
    tokenOut: T_OUT,
    amountIn: 100000000000000000000n,
    amountOut: 200000000000000000000n,
    gasReimburseIn: 0n,
    gasReimburseOut: 0n,
  }))
  return encodeFunctionData({
    abi: SETTLEMENT_WRITE_ABI,
    functionName: 'settleTradesBatch',
    args: [fills as never],
  })
}

function tradeEvent(logIndex: number, chainId: number) {
  // 块号必须 ≥ 各链 config 的 start_block，否则 simulate 会被路由过滤
  const blockNumber = chainId === BASE ? 56357293 : 12094797
  return {
    contract: 'Settlement',
    event: 'TradeSettled',
    params: {
      maker: MAKER,
      taker: TAKER,
      tokenIn: T_IN,
      tokenOut: T_OUT,
      amountIn: 100000000000000000000n,
      amountOut: 200000000000000000000n,
      feeAmount: 200000000000000000n,
    },
    block: { number: blockNumber, timestamp: 1700001000, hash: `0x${'ef'.repeat(32)}` },
    transaction: { hash: TX, input: batchCalldata() },
    srcAddress: SETTLEMENT[chainId],
    logIndex,
  }
}

describe('createTestIndexer 合成事件', () => {
  it('批量 tx 两笔成交不重不漏 + digest 按序关联 + GasShare 挂载', async () => {
    const indexer = createTestIndexer()
    await indexer.process({
      chains: {
        [SEPOLIA]: {
          simulate: [
            tradeEvent(5, SEPOLIA),
            tradeEvent(6, SEPOLIA),
            {
              contract: 'Settlement',
              event: 'GasCostShared',
              params: {
                maker: MAKER,
                taker: TAKER,
                gasRecipient: TAKER,
                gasUsed: 150000n,
                gasCostWei: 3000000000000000n,
                reason: 0n,
                makerToken: T_OUT,
                makerDeduct: 100n,
                makerShortfall: 0n,
                takerToken: T_IN,
                takerDeduct: 200n,
                takerShortfall: 0n,
              },
              block: { number: 12094797, timestamp: 1700001000, hash: `0x${'ef'.repeat(32)}` },
              transaction: { hash: TX },
              srcAddress: SETTLEMENT[SEPOLIA],
              logIndex: 7,
            },
          ],
        },
      },
    })
    const trades = await indexer.Trade.getWhere({ chainId: { _eq: SEPOLIA } })
    expect(trades.length).toBe(2)
    const first = await indexer.Trade.getOrThrow(tradeEntityId(SEPOLIA, TX, 5))
    const second = await indexer.Trade.getOrThrow(tradeEntityId(SEPOLIA, TX, 6))
    expect(first.digestAssociated).toBe(true)
    expect(first.makerDigest).toBe(orderDigest(order('m0', MAKER, 0n), SEPOLIA, SETTLEMENT[SEPOLIA]))
    expect(second.makerDigest).toBe(orderDigest(order('m1', MAKER, 1n), SEPOLIA, SETTLEMENT[SEPOLIA]))
    expect(first.makerDigest).not.toBe(second.makerDigest)

    const shares = await indexer.GasShare.getWhere({ chainId: { _eq: SEPOLIA } })
    expect(shares.length).toBe(1)
    expect(shares[0].trade_id_id).toBe(tradeEntityId(SEPOLIA, TX, 5))
  })

  it('calldata 缺失时 digest 留空未关联，不猜测', async () => {
    const indexer = createTestIndexer()
    const ev = tradeEvent(3, SEPOLIA)
    delete (ev.transaction as Record<string, unknown>).input
    await indexer.process({ chains: { [SEPOLIA]: { simulate: [ev] } } })
    const trade = await indexer.Trade.getOrThrow(tradeEntityId(SEPOLIA, TX, 3))
    expect(trade.digestAssociated).toBe(false)
    expect(trade.makerDigest ?? null).toBeNull()
  })

  it('双链同 txHash/序号：实体按链分隔', async () => {
    const indexer = createTestIndexer()
    await indexer.process({
      chains: {
        [SEPOLIA]: { simulate: [tradeEvent(5, SEPOLIA)] },
        [BASE]: { simulate: [tradeEvent(5, BASE)] },
      },
    })
    const sep = await indexer.Trade.getWhere({ chainId: { _eq: SEPOLIA } })
    const base = await indexer.Trade.getWhere({ chainId: { _eq: BASE } })
    expect(sep.length).toBe(1)
    expect(base.length).toBe(1)
    expect(sep[0].id).toBe(tradeEntityId(SEPOLIA, TX, 5))
    expect(base[0].id).toBe(tradeEntityId(BASE, TX, 5))
    // digest 域含 chainId 与合约地址，双链必然不同
    expect(sep[0].makerDigest).not.toBe(base[0].makerDigest)
  })
})
