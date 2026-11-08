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

/**
 * 按链生成 EIP-712 域（verifyingContract 取该链的 Settlement 地址）。
 * 下单/撤单签名必须用当前链的域，否则节点按本链域恢复出的地址不符、订单被拒。
 * 调用方一律传当前链 CHAIN_ID（见 orderSigning.ts / orderVerification.ts 的 chainId 参数）。
 */
export function getEIP712Domain(chainId: number) {
  const chain = getChainConfig(chainId)
  return {
    name: '比特100',
    version: '1',
    chainId: chain?.chainId ?? chainId,
    verifyingContract: chain?.contracts.settlement ?? ZERO_ADDRESS,
  }
}

/**
 * EIP-712 域分隔符（默认链 = Sepolia，与节点 signature.go 默认域一致）。
 * 仅作兼容保留：新代码一律用 getEIP712Domain(CHAIN_ID)，不要直接用它签 Base 链订单。
 */
export const EIP712_DOMAIN = {
  name: '比特100',
  version: '1',
  chainId: defaultChain?.chainId ?? 11155111, // Sepolia
  verifyingContract: defaultChain?.contracts.settlement ?? ZERO_ADDRESS,
}

/** 订单方向（阶段 3 Route A：side 进入 EIP-712 签名结构，置于末尾）。
 * 数值与订单簿/中继行的自报 side 字符串一一对应：buy ↔ 0、sell ↔ 1。
 * 语义相对签名交易对朝向：BUY 付 tokenOut 收 tokenIn；SELL 付 tokenIn 收 tokenOut。 */
export const SIDE_BUY = 0
export const SIDE_SELL = 1

export function sideToSignedValue(side: 'buy' | 'sell'): number {
  return side === 'sell' ? SIDE_SELL : SIDE_BUY
}

export function signedValueToSide(v: number): 'buy' | 'sell' | null {
  return v === SIDE_BUY ? 'buy' : v === SIDE_SELL ? 'sell' : null
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
    { name: 'side', type: 'uint8' },
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
  /** 签名方向（阶段 3）：SIDE_BUY=0 / SIDE_SELL=1，见上方常量 */
  side: number
}
