import { ethers } from 'ethers'
import { CHAIN_ID } from '../config'
import {
  getEIP712Domain,
  ORDER_TYPES,
  CANCEL_TYPES,
  type OrderData,
} from './orderSigningTypes'
import {
  allocateNonce,
  createNonceCursorStorage,
  nonceCursorStorageKey,
  nonceLockName,
} from './nonceAllocator'

export type { OrderData } from './orderSigningTypes'

/**
 * 下单签名。chainId 缺省为当前构建链（config.ts 的 CHAIN_ID，来自 VITE_CHAIN_ID）；
 * 域按链生成（verifyingContract 取该链 Settlement），Base 链订单不得用 Sepolia 域签。
 */
export async function signOrder(
  order: OrderData,
  signer: ethers.Signer,
  chainId: number = CHAIN_ID
): Promise<string> {
  return signer.signTypedData(getEIP712Domain(chainId), ORDER_TYPES, order)
}

const SETTLEMENT_NONCE_ABI = [
  'function nonceBitmap(address user, uint256 wordPos) view returns (uint256)',
]

/**
 * 分配本单的链上结算 nonce（第 62 轮起为无序位图语义）：由位图分配器
 * （nonceAllocator）取一个链上未消耗、且不被本客户端其他在途订单占用
 * 的 nonce——位图位在结算时才置位，只读链会让连下的两单撞同一 nonce。
 * settlementAddress 缺省取该链 Settlement（域绑定的 verifyingContract）。
 */
export async function fetchOrderNonce(
  userAddress: string,
  runner: ethers.ContractRunner,
  chainId: number = CHAIN_ID,
  settlementAddress?: string
): Promise<number> {
  const settlement = settlementAddress ?? getEIP712Domain(chainId).verifyingContract
  const contract = new ethers.Contract(settlement, SETTLEMENT_NONCE_ABI, runner)
  return allocateNonce(
    {
      readWord: async (wordPos: number) =>
        BigInt(await contract.nonceBitmap(userAddress, wordPos)),
    },
    createNonceCursorStorage(nonceCursorStorageKey(chainId, userAddress)),
    // 第 63 轮骑乘-1：同浏览器多标签页以 Web Locks 串行化分配临界区
    { lockName: nonceLockName(chainId, userAddress) },
  )
}

/** 撤单签名（域与下单签名同规则，按链生成）。 */
export async function signCancelOrder(
  orderId: string,
  userAddress: string,
  timestamp: number,
  signer: ethers.Signer,
  chainId: number = CHAIN_ID
): Promise<string> {
  return signer.signTypedData(getEIP712Domain(chainId), CANCEL_TYPES, {
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

// 兼容保留：默认链域（Sepolia）仍由 orderSigningTypes.ts 导出。新代码用 getEIP712Domain(chainId)。
