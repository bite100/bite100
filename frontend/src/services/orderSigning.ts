import { ethers } from 'ethers'

// EIP-712 域分隔符
const DOMAIN = {
  name: '比特100',
  version: '1',
  chainId: 11155111,  // Sepolia
  verifyingContract: '0x0000000000000000000000000000000000000000',  // 可选
}

// 订单类型定义
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

export interface OrderData {
  orderId: string
  userAddress: string
  tokenIn: string
  tokenOut: string
  amountIn: string
  amountOut: string
  price: string
  timestamp: number
  expiresAt: number
}

export async function signOrder(
  order: OrderData,
  signer: ethers.Signer
): Promise<string> {
  // 使用 EIP-712 签名
  const signature = await signer.signTypedData(DOMAIN, ORDER_TYPES, order)
  return signature
}

export async function signCancelOrder(
  orderId: string,
  userAddress: string,
  timestamp: number,
  signer: ethers.Signer
): Promise<string> {
  const CANCEL_TYPES = {
    CancelOrder: [
      { name: 'orderId', type: 'string' },
      { name: 'userAddress', type: 'address' },
      { name: 'timestamp', type: 'uint256' },
    ],
  }
  
  const signature = await signer.signTypedData(DOMAIN, CANCEL_TYPES, {
    orderId,
    userAddress,
    timestamp,
  })
  
  return signature
}

// 生成订单 ID
export function generateOrderId(): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(2, 11)
  return `order_${timestamp}_${random}`
}
