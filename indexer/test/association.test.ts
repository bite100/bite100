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
    // 阶段 3 切换：默认 side=1（sell），与规范 §6/§9 新向量口径一致
    // （冻结向量 side=1 → digest 0xd793…cec0）；本文件 calldata 全部由
    // encodeFunctionData 按新 ABI 运行时构造，无旧十六进制夹具需重生成。
    side: 1,
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
    // 阶段 3 冻结向量（side=1）：0xd793…cec0；旧向量（无 side）0x6a3c…d2f1 已作废
    expect(orderDigest(order(), 31337, ADDR.settlementVector)).toBe(
      '0xd793d795036c2d1b548120e9e73ea43a608529b4a23f0d3254c263fde391cec0',
    )
  })

  it('翻转 side 即换 digest（方向是被签名字段）', () => {
    expect(orderDigest(order({ side: 0 }), 31337, ADDR.settlementVector)).not.toBe(
      orderDigest(order({ side: 1 }), 31337, ADDR.settlementVector),
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
      '0xd793d795036c2d1b548120e9e73ea43a608529b4a23f0d3254c263fde391cec0',
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

  it('side 随 calldata 解码保留：maker sell=1 / taker buy=0，且 digest 用解码出的 side', () => {
    const f = fill(
      order({ side: 1 }),
      order({ orderId: 'taker_buy', userAddress: ADDR.other, side: 0 }),
    )
    const data = encodeFunctionData({
      abi: SETTLEMENT_WRITE_ABI,
      functionName: 'settleTrade',
      args: [f as never],
    })
    const fills = decodeSettleCalldata(data)
    expect(fills).not.toBeNull()
    expect(fills![0].makerOrder.side).toBe(1)
    expect(fills![0].takerOrder.side).toBe(0)
    const d = digestsForFillIndex(fills, 0, 31337, ADDR.settlementVector)
    expect(d?.takerDigest).toBe(
      orderDigest(
        order({ orderId: 'taker_buy', userAddress: ADDR.other, side: 0 }),
        31337,
        ADDR.settlementVector,
      ),
    )
    // 若 side 被丢弃/写死，taker digest 会与 side=1 的重算撞上——断言不撞
    expect(d?.takerDigest).not.toBe(
      orderDigest(
        order({ orderId: 'taker_buy', userAddress: ADDR.other, side: 1 }),
        31337,
        ADDR.settlementVector,
      ),
    )
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
