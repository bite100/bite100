/**
 * 订单 digest 关联（纯逻辑，可单测）：
 * 成交事件本身不带订单 digest——唯一可信来源是同一 tx 的 calldata：
 * 解码 settleTrade / settleTradesBatch* 的 Fill[]，按「第 i 个成交事件 ↔
 * 第 i 个 Fill」的同 tx 顺序对应（合约内每 Fill 恰好发射一个成交事件，
 * 顺序与 Fill 顺序一致），再按统一规范（docs/eip712-order-spec.md）用
 * viem hashTypedData 重算 maker/taker 订单 digest。
 *
 * 解不出（未知入口、解码失败、事件数与 Fill 数对不上）一律返回 null，
 * 由 handler 留空并标注未关联；绝不按地址+金额猜测归并。
 */
import { decodeFunctionData, hashTypedData } from 'viem'
import { SETTLEMENT_WRITE_ABI } from './settlementAbi'

/** EIP-712 订单类型（统一规范唯一事实源 docs/eip712-order-spec.md §5；与前端 orderSigningTypes 同形） */
export const ORDER_TYPES = {
  Order: [
    { name: 'orderId', type: 'string' },
    { name: 'userAddress', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'amountOut', type: 'uint256' },
    { name: 'price', type: 'uint256' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

export interface DecodedOrder {
  orderId: string
  userAddress: string
  tokenIn: string
  tokenOut: string
  amountIn: bigint
  amountOut: bigint
  price: bigint
  timestamp: bigint
  expiresAt: bigint
  nonce: bigint
}

export interface DecodedFill {
  makerOrder: DecodedOrder
  takerOrder: DecodedOrder
}

/** 解码 settle 系列 calldata → Fill[]；非 settle 入口/解码失败返回 null */
export function decodeSettleCalldata(input: string | undefined | null): DecodedFill[] | null {
  if (!input || !input.startsWith('0x') || input.length < 10) return null
  try {
    const decoded = decodeFunctionData({
      abi: SETTLEMENT_WRITE_ABI,
      data: input as `0x${string}`,
    })
    const args = decoded.args as unknown as unknown[]
    let fills: unknown
    switch (decoded.functionName) {
      case 'settleTrade':
        fills = [args[0]]
        break
      case 'settleTradesBatch':
      case 'settleTradesBatchWithGasSavings':
        fills = args[0]
        break
      case 'settleTradesBatchWithMerkle':
        fills = args[2]
        break
      default:
        return null
    }
    if (!Array.isArray(fills)) return null
    return fills.map((f) => {
      const fill = f as {
        makerOrder: { order: DecodedOrder }
        takerOrder: { order: DecodedOrder }
      }
      return { makerOrder: fill.makerOrder.order, takerOrder: fill.takerOrder.order }
    })
  } catch {
    return null
  }
}

/** 按统一规范重算单个订单的 EIP-712 digest */
export function orderDigest(
  order: DecodedOrder,
  chainId: number,
  settlementAddress: string,
): string {
  return hashTypedData({
    domain: {
      name: '比特100',
      version: '1',
      chainId,
      verifyingContract: settlementAddress as `0x${string}`,
    },
    types: ORDER_TYPES as never,
    primaryType: 'Order',
    message: {
      orderId: order.orderId,
      userAddress: order.userAddress as `0x${string}`,
      tokenIn: order.tokenIn as `0x${string}`,
      tokenOut: order.tokenOut as `0x${string}`,
      amountIn: order.amountIn,
      amountOut: order.amountOut,
      price: order.price,
      timestamp: order.timestamp,
      expiresAt: order.expiresAt,
      nonce: order.nonce,
    },
  })
}

export interface FillDigests {
  makerDigest: string
  takerDigest: string
}

/**
 * 第 index 个 Fill 的 maker/taker digest；fills 为 null 或 index 越界返回 null。
 * index = 该 tx 内已处理的成交事件数（handler 用 TxCursor 计数）。
 */
export function digestsForFillIndex(
  fills: DecodedFill[] | null,
  index: number,
  chainId: number,
  settlementAddress: string,
): FillDigests | null {
  if (!fills || index < 0 || index >= fills.length) return null
  const fill = fills[index]
  return {
    makerDigest: orderDigest(fill.makerOrder, chainId, settlementAddress),
    takerDigest: orderDigest(fill.takerOrder, chainId, settlementAddress),
  }
}

/** 成交实体唯一 ID（简报口径：chainId-txHash-logIndex） */
export function tradeEntityId(chainId: number, txHash: string, logIndex: number): string {
  return `${chainId}-${txHash.toLowerCase()}-${logIndex}`
}

/** GasShare 实体唯一 ID（同口径） */
export function gasShareEntityId(chainId: number, txHash: string, logIndex: number): string {
  return `${chainId}-${txHash.toLowerCase()}-${logIndex}`
}
