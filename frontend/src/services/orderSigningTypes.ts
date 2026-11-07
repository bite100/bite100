/**
 * EIP-712 订单签名共享类型与常量 —— 统一规范的唯一事实源见 docs/eip712-order-spec.md
 * 与 orderSigning.ts、orderVerification.ts、node/internal/match/signature.go、contracts/src/Settlement.sol 保持一致：
 * - 域为四字段 EIP712Domain(name, version, chainId, verifyingContract)，verifyingContract = Settlement 地址
 * - Order 结构含 nonce（签名者的链上结算 nonce，下单时读 Settlement.getCurrentNonce）
 * - amountOut = amountIn * price / 1e18（price 为 1e18 定点缩放）
 * 修改 domain/Order 结构时需四处同步（见 .cursor/skills/order-signing/SKILL.md）
 */
import { getChainConfig, DEFAULT_CHAIN_ID } from '../config/chains'

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const defaultChain = getChainConfig(DEFAULT_CHAIN_ID)

/** EIP-712 域分隔符（默认链 = Sepolia，与节点 signature.go 默认域一致） */
export const EIP712_DOMAIN = {
  name: '比特100',
  version: '1',
  chainId: defaultChain?.chainId ?? 11155111, // Sepolia
  verifyingContract: defaultChain?.contracts.settlement ?? ZERO_ADDRESS,
}

/** Order 类型定义（与 ethers TypedDataField[] 兼容；字段顺序即编码顺序） */
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
  /** 链上结算 nonce（Settlement.getCurrentNonce(userAddress)），结算时被合约消耗 */
  nonce: number
}
