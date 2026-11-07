import { ethers } from 'ethers'
import {
  EIP712_DOMAIN,
  ORDER_TYPES,
  CANCEL_TYPES,
  type OrderData,
} from './orderSigningTypes'

export type { OrderData } from './orderSigningTypes'

export async function signOrder(
  order: OrderData,
  signer: ethers.Signer
): Promise<string> {
  return signer.signTypedData(EIP712_DOMAIN, ORDER_TYPES, order)
}

const SETTLEMENT_NONCE_ABI = [
  'function getCurrentNonce(address user) view returns (uint256)',
]

/**
 * 读取用户当前链上结算 nonce（下单签名必须用它，结算时被合约消耗）。
 * settlementAddress 缺省用签名域绑定的 verifyingContract（即默认链 Settlement）。
 */
export async function fetchOrderNonce(
  userAddress: string,
  runner: ethers.ContractRunner,
  settlementAddress: string = EIP712_DOMAIN.verifyingContract
): Promise<number> {
  const contract = new ethers.Contract(settlementAddress, SETTLEMENT_NONCE_ABI, runner)
  const nonce: bigint = await contract.getCurrentNonce(userAddress)
  return Number(nonce)
}

export async function signCancelOrder(
  orderId: string,
  userAddress: string,
  timestamp: number,
  signer: ethers.Signer
): Promise<string> {
  return signer.signTypedData(EIP712_DOMAIN, CANCEL_TYPES, {
    orderId,
    userAddress,
    timestamp,
  })
}

/** 生成订单 ID（使用 crypto 增强随机性） */
export function generateOrderId(): string {
  const timestamp = Date.now()
  const bytes = new Uint8Array(9)
  crypto.getRandomValues(bytes)
  const random = Array.from(bytes)
    .map((b) => (b % 36).toString(36))
    .join('')
  return `order_${timestamp}_${random}`
}
