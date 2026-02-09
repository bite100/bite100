/**
 * 订单签名验证（EIP-712）
 * 与 orderSigning.ts 及节点 internal/match/signature.go 结构一致，防止订单伪造
 */
import { ethers } from 'ethers'
import type { OrderData } from './orderSigning'

const DOMAIN = {
  name: 'P2P DEX',
  version: '1',
  chainId: 11155111,
  verifyingContract: '0x0000000000000000000000000000000000000000' as const,
}

const ORDER_TYPES = {
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
  ],
}

const CANCEL_TYPES = {
  CancelOrder: [
    { name: 'orderId', type: 'string' },
    { name: 'userAddress', type: 'address' },
    { name: 'timestamp', type: 'uint256' },
  ],
}

/**
 * 验证订单签名（与 orderSigning 的 OrderData 一致）
 * @param orderData 签名时的订单数据（含 userAddress, tokenIn, tokenOut, amountIn, amountOut, price, timestamp, expiresAt）
 * @param signature 0x 前缀的签名
 * @returns 验证通过返回 true
 */
export async function verifyOrderSignatureSignedData(
  orderData: OrderData,
  signature: string
): Promise<boolean> {
  try {
    if (!signature || !orderData.userAddress) return false
    const recovered = await ethers.verifyTypedData(
      DOMAIN,
      ORDER_TYPES,
      {
        orderId: orderData.orderId,
        userAddress: orderData.userAddress,
        tokenIn: orderData.tokenIn || '0x0000000000000000000000000000000000000000',
        tokenOut: orderData.tokenOut || '0x0000000000000000000000000000000000000000',
        amountIn: orderData.amountIn,
        amountOut: orderData.amountOut,
        price: orderData.price,
        timestamp: orderData.timestamp,
        expiresAt: orderData.expiresAt,
      },
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
      DOMAIN,
      CANCEL_TYPES,
      { orderId, userAddress, timestamp },
      signature
    )
    return recovered.toLowerCase() === userAddress.toLowerCase()
  } catch {
    return false
  }
}
