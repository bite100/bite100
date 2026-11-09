/**
 * 第 46 轮：链上硬撤单服务层（无节点化阶段 5 前置）。
 *
 * 背景：此前所有 UI 撤单路径只走节点签名撤单（POST /api/order/cancel），
 * 节点停机时网页撤不了单、锁住的 Vault 余额只能等订单过期。本服务让
 * 用户用自己的钱包直接调用 Vault.releaseOrderLock(digest) 释放锁定。
 *
 * 合约语义（contracts/src/Vault.sol / Settlement.sol，读码结论）：
 * - releaseOrderLock：locker 或锁属用户本人可调用，删除锁记录并把
 *   locked 计数扣回（余额立即可用）。
 * - 结算路径 _verifyFill → _accountFill 无条件调用
 *   Vault.consumeOrderLock，无锁记录即 revert（"Vault: order not
 *   locked"），不存在用可用余额兜底结算的路径——**锁释放后该订单
 *   永远无法再成交**，即使它还留在节点/中继订单簿里。
 *
 * 骑乘（不另造轮子）：
 * - digest 重算：dualread/digest 的 buildSignedOrderData +
 *   computeOrderDigest（与节点/中继/双读三方同口径）；
 * - 发交易/等回执：ethers Contract + 既有 getSigner() 钱包签名者 +
 *   tx.wait()（与 AssetsPage 存取、MakerVaultPage 同一写法）；
 * - 合约接口：services/vaultAbi.ts 的 VAULT_LOCK_ABI（自动生成子集，
 *   含 orderLocks / releaseOrderLock）。
 */
import { ethers } from 'ethers'
import { VAULT_ADDRESS } from '../config'
import { VAULT_LOCK_ABI } from './vaultAbi'
import { buildSignedOrderData, computeOrderDigest } from './dualread/digest'
import type { RawOrder } from './dualread/types'

export interface OrderLockState {
  user: string
  token: string
  remaining: bigint
  expiresAt: bigint
}

/** Vault 锁相关接口的最小结构（ethers Contract 满足之；单测注入假件） */
export interface VaultLockContractLike {
  orderLocks(
    digest: string,
  ): Promise<OrderLockState | [string, string, bigint, bigint]>
  releaseOrderLock(
    digest: string,
  ): Promise<{ hash: string; wait(): Promise<{ status: number | null } | null> }>
}

/** 以既有 ethers 写法构造 Vault 锁合约（runner 可为 provider 或 signer） */
export function createVaultLockContract(
  runner: ethers.ContractRunner,
  vaultAddress: string = VAULT_ADDRESS,
): VaultLockContractLike {
  return new ethers.Contract(
    vaultAddress,
    VAULT_LOCK_ABI,
    runner,
  ) as unknown as VaultLockContractLike
}

function normalizeLock(
  raw: OrderLockState | [string, string, bigint, bigint],
): OrderLockState {
  if (Array.isArray(raw)) {
    return { user: raw[0], token: raw[1], remaining: raw[2], expiresAt: raw[3] }
  }
  return raw
}

export type HardCancelResult =
  | { status: 'released'; digest: string; txHash: string }
  | { status: 'not-locked'; digest: string }

/**
 * 对一张自己的未成交订单执行链上硬撤单：
 * 重算 digest → 读 orderLocks 确认锁在且属本人 → 发 releaseOrderLock
 * → 等回执 → 回读 orderLocks 确认锁已消失，才报 released。
 * 锁不存在（从未落锁/已释放/已耗尽）返回 not-locked，不发交易。
 * 任一步失败抛错（由 UI 经 formatError 如实呈现），绝不假成功。
 */
export async function hardCancelOrderOnChain(args: {
  order: RawOrder
  chainId: number
  signer: ethers.Signer
  /** 单测注入点；缺省按 signer 构造真实合约 */
  vault?: VaultLockContractLike
}): Promise<HardCancelResult> {
  const data = buildSignedOrderData(args.order, args.chainId)
  if (!data) {
    throw new Error('订单数据不完整，无法重算链上订单摘要，不能执行链上撤单')
  }
  const digest = computeOrderDigest(data, args.chainId)
  const vault = args.vault ?? createVaultLockContract(args.signer)
  const me = await args.signer.getAddress()

  const lock = normalizeLock(await vault.orderLocks(digest))
  if (lock.user === ethers.ZeroAddress) {
    return { status: 'not-locked', digest }
  }
  if (lock.user.toLowerCase() !== me.toLowerCase()) {
    throw new Error('这张订单的链上锁定不属于当前钱包，无法由你释放')
  }

  const tx = await vault.releaseOrderLock(digest)
  const receipt = await tx.wait()
  if (!receipt || receipt.status === 0) {
    throw new Error('链上撤单交易未成功（回执状态异常），锁定可能仍在，请稍后重试')
  }
  const after = normalizeLock(await vault.orderLocks(digest))
  if (after.user !== ethers.ZeroAddress) {
    throw new Error('链上撤单已提交，但回读确认锁仍存在，请稍后在列表中确认状态')
  }
  return { status: 'released', digest, txHash: tx.hash }
}
