/**
 * EIP-712 订单签名共享类型与常量
 * 与 orderSigning.ts、orderVerification.ts、node/internal/match/signature.go 保持一致
 * 修改 domain/Order 结构时需三处同步（见 .cursor/skills/order-signing/SKILL.md）
 */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** EIP-712 域分隔符（chainId 与节点 signature.go 一致） */
export const EIP712_DOMAIN = {
  name: '比特100',
  version: '1',
  chainId: 11155111, // Sepolia
  verifyingContract: ZERO_ADDRESS,
}

/** Order 类型定义（与 ethers TypedDataField[] 兼容） */
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
  ],
}

/** CancelOrder 类型定义 */
export const CANCEL_TYPES = {
  CancelOrder: [
    { name: 'orderId', type: 'string' },
    { name: 'userAddress', type: 'address' },
    { name: 'timestamp', type: 'uint256' },
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
