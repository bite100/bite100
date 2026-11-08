/**
 * 第 34 轮双读 — 签名订单重构与 digest 本地重算。
 *
 * 简报纪律：摘要口径与既有签名代码一致，不许写第二套实现——
 * 域与类型一律取 services/orderSigningTypes.ts（ORDER_TYPES / getEIP712Domain），
 * 字段重构口径与节点（node/internal/orderbook.BuildSignedOrder）、中继
 * （relay/src/orders.ts 的 buildSignedOrder）三方一致：
 * - tokenIn/tokenOut 恒为交易对 (Token0, Token1)，与买卖方向无关（方向由
 *   未签名的 side 字段表达，见 docs/eip712-order-spec.md §2/§4）；
 * - amountOut 按第 29 轮规范整数公式 amountIn × price / 1e18 重算
 *   （源行里的 amountOut 字段一律不采信，防舍入漂移/伪造）；
 * - timestamp = createdAt；expiresAt 为 0/缺失时按默认 7 天推导
 *   （与节点 settle 路径的兜底口径一致）。
 *
 * 本文件只负责「重构 + 摘要」，验签仍走既有
 * services/orderVerification.ts 的 verifyOrderSignatureSignedData。
 */
import { ethers } from 'ethers'
import {
  ORDER_TYPES,
  getEIP712Domain,
  type OrderData,
} from '../orderSigningTypes'
import { getPairTokens } from '../../config/pairs'
import type { RawOrder } from './types'

/** expiresAt 缺省推导（与节点 node/internal/settlement/client.go 口径一致） */
export const DEFAULT_ORDER_TTL_SEC = 7 * 24 * 3600

const WEI = 10n ** 18n

/** 原始订单行 → 签名订单字段（OrderData）。交易对未知/金额非法时返回 null。 */
export function buildSignedOrderData(raw: RawOrder, chainId: number): OrderData | null {
  const tokens = getPairTokens(chainId, raw.pair)
  if (!tokens) return null
  let amountIn: bigint
  let price: bigint
  try {
    amountIn = BigInt(raw.amount)
    price = BigInt(raw.price)
  } catch {
    return null
  }
  if (amountIn < 0n || price < 0n) return null
  // 第 29 轮规范整数公式：amountOut = amountIn * price / 1e18（整数除法）
  const amountOut = (amountIn * price) / WEI
  const createdAt = Number(raw.createdAt) || 0
  const expiresAt =
    raw.expiresAt && Number(raw.expiresAt) !== 0
      ? Number(raw.expiresAt)
      : createdAt + DEFAULT_ORDER_TTL_SEC
  return {
    orderId: raw.orderId,
    userAddress: raw.trader,
    tokenIn: tokens.base,
    tokenOut: tokens.quote,
    amountIn: amountIn.toString(),
    amountOut: amountOut.toString(),
    price: price.toString(),
    timestamp: createdAt,
    expiresAt,
    nonce: Number(raw.nonce) || 0,
  }
}

/**
 * 按给定域计算订单 digest。ethers 的 TypedDataEncoder 与节点（go-ethereum）、
 * 中继（viem）对同一 (域， 类型， 消息） 产出一致摘要（规范测试向量见
 * docs/eip712-order-spec.md §6，单测 dualread.test.ts 覆盖）。
 */
export function hashOrderWithDomain(
  domain: ReturnType<typeof getEIP712Domain>,
  data: OrderData,
): string {
  const message = {
    orderId: data.orderId,
    userAddress: data.userAddress,
    tokenIn: data.tokenIn,
    tokenOut: data.tokenOut,
    amountIn: data.amountIn,
    amountOut: data.amountOut,
    price: data.price,
    timestamp: data.timestamp,
    expiresAt: data.expiresAt,
    nonce: data.nonce,
  }
  return ethers.TypedDataEncoder.hash(
    domain as ethers.TypedDataDomain,
    ORDER_TYPES as unknown as Record<string, ethers.TypedDataField[]>,
    message,
  )
}

/** 按链重算订单 digest（域的 verifyingContract 取该链当前 Settlement） */
export function computeOrderDigest(data: OrderData, chainId: number): string {
  return hashOrderWithDomain(getEIP712Domain(chainId), data)
}
