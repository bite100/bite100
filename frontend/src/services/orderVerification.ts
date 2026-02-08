/**
 * 订单签名验证（安全）
 * 验证 maker 地址，防止订单伪造
 */
import { ethers } from 'ethers'
import type { Order, CancelRequest } from '../p2p/types'

// EIP-712 域分隔符（与 orderSigning.ts 一致）
const DOMAIN = {
  name: 'P2P DEX',
  version: '1',
  chainId: 11155111,  // Sepolia
  verifyingContract: '0x0000000000000000000000000000000000000000',
}

// 订单类型定义（匹配实际 Order 结构）
const ORDER_TYPES = {
  Order: [
    { name: 'orderId', type: 'string' },
    { name: 'trader', type: 'address' },
    { name: 'pair', type: 'string' },
    { name: 'side', type: 'string' },
    { name: 'price', type: 'uint256' },
    { name: 'amount', type: 'uint256' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
  ],
}

/**
 * 验证订单签名
 * @param order 订单数据
 * @returns 验证通过返回 true，否则返回 false
 */
export async function verifyOrderSignature(order: Order): Promise<boolean> {
  try {
    if (!order.signature) {
      return false
    }

    // 构建订单数据（匹配 EIP-712 格式）
    const orderData = {
      orderId: order.orderId,
      trader: order.trader,
      pair: order.pair,
      side: order.side,
      price: order.price,
      amount: order.amount,
      timestamp: order.timestamp,
      expiresAt: order.expiresAt || 0,
    }

    // 使用 EIP-712 验证签名
    const recoveredAddress = ethers.verifyTypedData(
      DOMAIN,
      ORDER_TYPES,
      orderData,
      order.signature
    )

    // 验证签名者地址与订单 trader 地址一致
    return recoveredAddress.toLowerCase() === order.trader.toLowerCase()
  } catch (error) {
    console.error('订单签名验证失败:', error)
    return false
  }
}

/**
 * 验证撤单签名
 * @param cancel 撤单请求
 * @param traderAddress 交易者地址（需要从订单中获取）
 * @returns 验证通过返回 true，否则返回 false
 */
export async function verifyCancelOrderSignature(
  cancel: CancelRequest,
  traderAddress: string
): Promise<boolean> {
  try {
    if (!cancel.signature) {
      return false
    }

    const CANCEL_TYPES = {
      CancelOrder: [
        { name: 'orderId', type: 'string' },
        { name: 'traderAddress', type: 'address' },
      ],
    }

    const recoveredAddress = ethers.verifyTypedData(
      DOMAIN,
      CANCEL_TYPES,
      { orderId: cancel.orderId, traderAddress },
      cancel.signature
    )

    return recoveredAddress.toLowerCase() === traderAddress.toLowerCase()
  } catch (error) {
    console.error('撤单签名验证失败:', error)
    return false
  }
}
