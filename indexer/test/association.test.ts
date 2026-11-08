/**
 * digest 关联纯逻辑测试（无账号、离线可跑）：
 * - digest 重算命中统一规范测试向量（docs/eip712-order-spec.md §6）；
 * - settleTrade / settleTradesBatch calldata 解码与按序关联；
 * - 批量 tx 多笔成交不重不漏（索引 0..n-1 各得其 Fill，越界为 null）；
 * - 解不出（垃圾输入/未知入口）返回 null，绝不猜测归并；
 * - 双链实体 ID 分隔。
 */
import { describe, it, expect } from 'vitest'
import { encodeFunctionData } from 'viem'
import { SETTLEMENT_WRITE_ABI } from '../src/lib/settlementAbi'
import {
  decodeSettleCalldata,
  digestsForFillIndex,
  orderDigest,
  tradeEntityId,
  type DecodedOrder,
} from '../src/lib/association'

const ADDR = {
  settlementVector: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  user: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  tIn: '0x1111111111111111111111111111111111111111',
  tOut: '0x2222222222222222222222222222222222222222',
  other: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
} as const

function order(over: Partial<DecodedOrder> = {}): DecodedOrder {
  return {
    orderId: 'order_vector_1',
    userAddress: ADDR.user,
    tokenIn: ADDR.tIn,
    tokenOut: ADDR.tOut,
    amountIn: 100000000000000000000n,
    amountOut: 200000000000000000000n,
    price: 2000000000000000000n,
    timestamp: 1700000000n,
    expiresAt: 1700086400n,
    nonce: 0n,
    ...over,
  }
}

function fill(maker: DecodedOrder, taker: DecodedOrder) {
  return {
    makerOrder: { order: maker, signature: '0x1234' as `0x${string}` },
    takerOrder: { order: taker, signature: '0x5678' as `0x${string}` },
    tokenIn: maker.tokenIn,
    tokenOut: maker.tokenOut,
    amountIn: maker.amountIn,
    amountOut: maker.amountOut,
    gasReimburseIn: 0n,
    gasReimburseOut: 0n,
  }
}

describe('orderDigest 规范向量', () => {
  it('与 docs/eip712-order-spec.md §6 期望 digest 逐字一致', () => {
    expect(orderDigest(order(), 31337, ADDR.settlementVector)).toBe(
      '0x6a3c557cec5b51cb843652a7a36b96bccc9eecc4eca030745110706cbfc8d2f1',
    )
  })
})

describe('decodeSettleCalldata + 按序关联', () => {
  it('settleTrade 单笔：解码出 1 个 Fill 且 digest 关联正确', () => {
    const f = fill(order(), order({ orderId: 'taker_1', userAddress: ADDR.other }))
    const data = encodeFunctionData({
      abi: SETTLEMENT_WRITE_ABI,
      functionName: 'settleTrade',
      args: [f as never],
    })
    const fills = decodeSettleCalldata(data)
    expect(fills).not.toBeNull()
    expect(fills!.length).toBe(1)
    const d = digestsForFillIndex(fills, 0, 31337, ADDR.settlementVector)
    expect(d?.makerDigest).toBe(
      '0x6a3c557cec5b51cb843652a7a36b96bccc9eecc4eca030745110706cbfc8d2f1',
    )
    expect(d?.takerDigest).toBe(
      orderDigest(order({ orderId: 'taker_1', userAddress: ADDR.other }), 31337, ADDR.settlementVector),
    )
    expect(digestsForFillIndex(fills, 1, 31337, ADDR.settlementVector)).toBeNull()
  })

  it('settleTradesBatch 三笔：索引 0/1/2 各得其 Fill，不重不漏', () => {
    const fillsIn = [0, 1, 2].map((i) =>
      fill(
        order({ orderId: `batch_maker_${i}`, nonce: BigInt(i) }),
        order({ orderId: `batch_taker_${i}`, userAddress: ADDR.other, nonce: BigInt(i) }),
      ),
    )
    const data = encodeFunctionData({
      abi: SETTLEMENT_WRITE_ABI,
      functionName: 'settleTradesBatch',
      args: [fillsIn as never],
    })
    const fills = decodeSettleCalldata(data)
    expect(fills!.length).toBe(3)
    const digests = [0, 1, 2].map(
      (i) => digestsForFillIndex(fills, i, 11155111, ADDR.settlementVector)!.makerDigest,
    )
    expect(new Set(digests).size).toBe(3)
    for (let i = 0; i < 3; i++) {
      expect(digests[i]).toBe(
        orderDigest(
          order({ orderId: `batch_maker_${i}`, nonce: BigInt(i) }),
          11155111,
          ADDR.settlementVector,
        ),
      )
    }
    expect(digestsForFillIndex(fills, 3, 11155111, ADDR.settlementVector)).toBeNull()
  })

  it('解不出就留空：空输入/垃圾输入/未知 selector 一律 null', () => {
    expect(decodeSettleCalldata(undefined)).toBeNull()
    expect(decodeSettleCalldata('')).toBeNull()
    expect(decodeSettleCalldata('0x')).toBeNull()
    expect(decodeSettleCalldata('0xdeadbeef' + '00'.repeat(64))).toBeNull()
    expect(digestsForFillIndex(null, 0, 11155111, ADDR.settlementVector)).toBeNull()
  })
})

describe('实体 ID', () => {
  it('格式 chainId-txHash-logIndex；双链同 tx/序号也分隔', () => {
    const tx = `0x${'AB'.repeat(32)}`
    expect(tradeEntityId(11155111, tx, 7)).toBe(`11155111-${tx.toLowerCase()}-7`)
    expect(tradeEntityId(84532, tx, 7)).not.toBe(tradeEntityId(11155111, tx, 7))
  })
})
