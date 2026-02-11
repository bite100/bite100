/**
 * 订单签名验证（EIP-712）
 * 与 orderSigning.ts 及节点 internal/match/signature.go 结构一致，防止订单伪造
 */
import { ethers } from 'ethers'
import {
  EIP712_DOMAIN,
  ORDER_TYPES,
  CANCEL_TYPES,
  ZERO_ADDRESS,
  type OrderData,
} from './orderSigningTypes'

export type { OrderData } from './orderSigningTypes'

function toMessage(orderData: OrderData) {
  return {
    orderId: orderData.orderId,
    userAddress: orderData.userAddress,
    tokenIn: orderData.tokenIn || ZERO_ADDRESS,
    tokenOut: orderData.tokenOut || ZERO_ADDRESS,
    amountIn: orderData.amountIn,
    amountOut: orderData.amountOut,
    price: orderData.price,
    timestamp: orderData.timestamp,
    expiresAt: orderData.expiresAt,
  }
}

/**
 * 验证订单签名（与 orderSigning 的 OrderData 一致）
 * @param orderData 签名时的订单数据
 * @param signature 0x 前缀的签名
 * @param options.checkExpiry 是否拒绝已过期订单（默认 true，Replay 防护）
 * @returns 验证通过返回 true
 */
export async function verifyOrderSignatureSignedData(
  orderData: OrderData,
  signature: string,
  options?: { checkExpiry?: boolean }
): Promise<boolean> {
  try {
    if (!signature || !orderData.userAddress) return false
    if (options?.checkExpiry !== false && orderData.expiresAt > 0) {
      if (orderData.expiresAt < Math.floor(Date.now() / 1000)) return false
    }
    const recovered = await ethers.verifyTypedData(
      EIP712_DOMAIN,
      ORDER_TYPES,
      toMessage(orderData),
      signature
    )
    return recovered.toLowerCase() === orderData.userAddress.toLowerCase()
  } catch {
    return false
  }
}

/**
 * 验证撤单签名（与 orderSigning 的 signCancelOrder 一致）
 */
export async function verifyCancelSignature(
  orderId: string,
  userAddress: string,
  timestamp: number,
  signature: string
): Promise<boolean> {
  try {
    if (!signature || !userAddress) return false
    const recovered = await ethers.verifyTypedData(
      EIP712_DOMAIN,
      CANCEL_TYPES,
      { orderId, userAddress, timestamp },
      signature
    )
    return recovered.toLowerCase() === userAddress.toLowerCase()
  } catch {
    return false
  }
}
