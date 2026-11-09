/**
 * 第 46 轮：链上硬撤单服务层（无节点化阶段 5 前置）。
 * 第 47 轮：对齐永久撤单语义（撤单墓碑）与无锁三态区分。
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
 *   locked"），不存在用可用余额兜底结算的路径。
 * - 【第 47 轮】releaseOrderLock 同时置撤单墓碑 cancelledOrders，
 *   lockForOrder 遇墓碑直接 revert：**链上撤单 = 立即解锁 + 该单永久
 *   作废、不可再落锁、不可再成交**（第 46 轮时只删锁记录，任何人拿
 *   公开签名单可重新落锁——第 46 轮 ChatGPT 复审 P1，本轮合约修复）。
 *   锁定被成交完全消耗时同样置位（订单已完全成交、永久关闭）。
 *
 * 无锁时的状态区分（第 46 轮复审 P1-2，不再合并成一句「无法再成交」）：
 * - never-locked：无锁、无落锁墓碑（lockTombstones）、无撤单墓碑——
 *   从未落锁；订单本身没有作废，过期前仍可能被落锁并成交。
 * - already-cancelled：撤单墓碑已置位且未全成交——此前已链上撤单，
 *   永久作废。
 * - filled：撤单墓碑已置位（耗尽分支）且累计成交已满——已全部成交。
 * - expired-released：无锁、有落锁墓碑、无撤单墓碑——锁定已随过期
 *   释放路径清掉（releaseExpiredOrderLock 不置撤单墓碑），订单已过期。
 * 旧栈（第 47 轮切换前）没有 cancelledOrders 读口：读取失败时本服务
 * 降级为第 46 轮口径（generic 归入 never-locked 的保守呈现），切换
 * 完成后自动走新口径。
 *
 * 骑乘（不另造轮子）：
 * - digest 重算：dualread/digest 的 buildSignedOrderData +
 *   computeOrderDigest（与节点/中继/双读三方同口径）；
 * - 发交易/等回执：ethers Contract + 既有 getSigner() 钱包签名者 +
 *   tx.wait()（与 AssetsPage 存取、MakerVaultPage 同一写法）；
 * - 合约接口：services/vaultAbi.ts 的 VAULT_LOCK_ABI（自动生成子集，
 *   含 orderLocks / lockTombstones / cancelledOrders / releaseOrderLock）；
 * - 累计成交读取：dualread/chainState.ts 的 SETTLEMENT_READ_ABI
 *   （orderFilledIn，双读链上状态同一 ABI 片段）。
 */
import { ethers } from 'ethers'
import { SETTLEMENT_ADDRESS, VAULT_ADDRESS } from '../config'
import { VAULT_LOCK_ABI } from './vaultAbi'
import { buildSignedOrderData, computeOrderDigest } from './dualread/digest'
import { SETTLEMENT_READ_ABI } from './dualread/chainState'
import type { RawOrder } from './dualread/types'

export interface OrderLockState {
  user: string
  token: string
  remaining: bigint
  expiresAt: bigint
}

export interface LockTombstoneState {
  user: string
  token: string
}

/** Vault 锁相关接口的最小结构（ethers Contract 满足之；单测注入假件） */
export interface VaultLockContractLike {
  orderLocks(
    digest: string,
  ): Promise<OrderLockState | [string, string, bigint, bigint]>
  lockTombstones(
    digest: string,
  ): Promise<LockTombstoneState | [string, string]>
  cancelledOrders(digest: string): Promise<boolean>
  releaseOrderLock(
    digest: string,
  ): Promise<{ hash: string; wait(): Promise<{ status: number | null } | null> }>
}

/** Settlement 累计成交接口的最小结构（单测注入假件） */
export interface SettlementFilledLike {
  orderFilledIn(digest: string): Promise<bigint>
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
  /** 从未落锁：没有可释放的锁定；订单本身没有作废 */
  | { status: 'never-locked'; digest: string }
  /** 此前已链上撤单（撤单墓碑已置位、未全成交）：永久作废 */
  | { status: 'already-cancelled'; digest: string }
  /** 已全部成交：锁定随成交消耗完毕 */
  | { status: 'filled'; digest: string }
  /** 锁定已随过期释放路径清掉（订单已过期） */
  | { status: 'expired-released'; digest: string }

/** 以既有 ethers 写法构造 Settlement 累计成交读口（ABI 骑 dualread 片段） */
export function createSettlementFilledReader(
  runner: ethers.ContractRunner,
  settlementAddress: string = SETTLEMENT_ADDRESS,
): SettlementFilledLike {
  return new ethers.Contract(
    settlementAddress,
    SETTLEMENT_READ_ABI as unknown as ethers.InterfaceAbi,
    runner,
  ) as unknown as SettlementFilledLike
}

function normalizeTombstone(
  raw: LockTombstoneState | [string, string],
): LockTombstoneState {
  if (Array.isArray(raw)) {
    return { user: raw[0], token: raw[1] }
  }
  return raw
}

/** 读撤单墓碑；旧栈无此读口（调用失败）时返回 null 表示不可用，调用方降级 */
async function readCancelled(
  vault: VaultLockContractLike,
  digest: string,
): Promise<boolean | null> {
  try {
    return await vault.cancelledOrders(digest)
  } catch {
    return null
  }
}

/**
 * 对一张自己的未成交订单执行链上硬撤单：
 * 重算 digest → 读 orderLocks 确认锁在且属本人 → 发 releaseOrderLock
 * → 等回执 → 回读 orderLocks 确认锁已消失（新栈再回读撤单墓碑确认
 * 已置位），才报 released。锁不存在时不发交易，按墓碑/落锁墓碑/
 * 累计成交区分 never-locked / already-cancelled / filled /
 * expired-released 四态返回（见文件头）。
 * 任一步失败抛错（由 UI 经 formatError 如实呈现），绝不假成功。
 */
export async function hardCancelOrderOnChain(args: {
  order: RawOrder
  chainId: number
  signer: ethers.Signer
  /** 单测注入点；缺省按 signer 构造真实合约 */
  vault?: VaultLockContractLike
  /** 单测注入点；缺省按 signer 构造真实 Settlement 读口 */
  settlement?: SettlementFilledLike
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
    const cancelled = await readCancelled(vault, digest)
    if (cancelled === null) {
      // 旧栈降级（第 46 轮口径）：无从区分细分状态，保守归入从未落锁呈现
      return { status: 'never-locked', digest }
    }
    if (cancelled) {
      // 已永久关闭：区分「已全部成交」与「此前已撤单」
      let filledIn = 0n
      try {
        const settlement =
          args.settlement ?? createSettlementFilledReader(args.signer)
        filledIn = await settlement.orderFilledIn(digest)
      } catch {
        filledIn = 0n
      }
      return filledIn >= BigInt(data.amountIn)
        ? { status: 'filled', digest }
        : { status: 'already-cancelled', digest }
    }
    const tomb = normalizeTombstone(await vault.lockTombstones(digest))
    return tomb.user === ethers.ZeroAddress
      ? { status: 'never-locked', digest }
      : { status: 'expired-released', digest }
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
  // 新栈再回读撤单墓碑：释放与置位同事务，墓碑不在则不算完成；
  // 旧栈无此读口（null）时跳过，与切换前行为一致。
  const cancelledAfter = await readCancelled(vault, digest)
  if (cancelledAfter === false) {
    throw new Error('链上撤单已提交、锁定已释放，但回读未确认永久作废标记，请稍后在列表中确认状态')
  }
  return { status: 'released', digest, txHash: tx.hash }
}
