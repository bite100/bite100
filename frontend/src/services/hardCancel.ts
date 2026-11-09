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
 * 旧栈（第 47 轮切换前）没有 cancelledOrders 读口。第 48 轮起读
 * 容错分三态（第 47 轮复审骑乘项）：**方法不存在**（老栈，须有
 * missing revert data 等 selector 缺失证据；第 50 轮起裸
 * CALL_EXCEPTION 不算证据——它是 ethers 通用 revert 码）才降级
 * 为第 46 轮口径；**传输/读取失败**（网络、节点异常）与前者严格分开——无
 * 锁分支返回 unknown「状态待确认」不下结论，已成交量读取失败同
 * 样返回 unknown（旧实现默认 0n 会把已成交误报成已撤单），释放
 * 后墓碑回读失败也归 unknown（锁定已释放的事实另行成立）。
 *
 * 骑乘（不另造轮子）：
 * - digest 重算：dualread/digest 的 buildSignedOrderData +
 *   computeOrderDigest（与节点/中继/双读三方同口径）；
 * - 发交易/等回执：ethers Contract + 既有 getSigner() 钱包签名者 +
 *   tx.wait()（与 AssetsPage 存取同一写法）；
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
  /**
   * 状态待确认（第 48 轮）：关键链上读数因传输/节点故障没读到，
   * 本服务不下任何结论（区别于「老栈没这个读口」的降级路径）；
   * UI 须按待确认呈现，提示用户稍后重新确认、不要重复提交。
   */
  | { status: 'unknown'; digest: string; reason: string }

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

/**
 * 「方法不存在」分类（第 48 轮立、第 50 轮收紧）：旧栈 Vault 没有
 * cancelledOrders 方法，链上 eth_call 失败；只有能证明 selector
 * 缺失的证据（消息文本类信号）才代表「老栈没读口」；其余（网络
 * 中断、节点 5xx、超时）都是读数没拿到，不得混为一谈。
 *
 * 第 50 轮收紧：第 48 轮把裸 `code === 'CALL_EXCEPTION'` 也算作
 * 没读口——但 CALL_EXCEPTION 是 ethers v6 对 eth_call 失败的通用
 * 错误码，方法存在但合约真 revert（带业务原因）同样是它。真
 * revert 被误判没读口会降级成 never-locked，绕过第 48 轮的
 * unknown 保护。现只保留消息类证据：旧栈无此方法时 ethers 的
 * 报错带 'missing revert data'（data=null，无 revert 数据可解），
 * 部分客户端报 'function selector was not recognized' /
 * 'method not found'——三者都能证明 selector 不被识别；裸
 * CALL_EXCEPTION（哪怕伴随 execution reverted 业务原因）一律
 * 归读失败 → unknown 路径，宁可待确认、不可误下「从未落锁」。
 */
export function isMethodMissingError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const msg = e.message ?? ''
  return (
    msg.includes('missing revert data') ||
    msg.includes('function selector was not recognized') ||
    msg.includes('method not found')
  )
}

type CancelledRead =
  | { kind: 'value'; value: boolean }
  | { kind: 'method-missing' }
  | { kind: 'read-failed'; error: string }

/** 读撤单墓碑（三态）：读到值 / 老栈没读口 / 读取失败，严格分开 */
async function readCancelled(
  vault: VaultLockContractLike,
  digest: string,
): Promise<CancelledRead> {
  try {
    return { kind: 'value', value: await vault.cancelledOrders(digest) }
  } catch (e) {
    if (isMethodMissingError(e)) return { kind: 'method-missing' }
    return {
      kind: 'read-failed',
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * 对一张自己的未成交订单执行链上硬撤单：
 * 重算 digest → 读 orderLocks 确认锁在且属本人 → 发 releaseOrderLock
 * → 等回执 → 回读 orderLocks 确认锁已消失（新栈再回读撤单墓碑确认
 * 已置位），才报 released。锁不存在时不发交易，按墓碑/落锁墓碑/
 * 累计成交区分 never-locked / already-cancelled / filled /
 * expired-released 四态返回（见文件头）；关键读数因传输故障没读
 * 到时返回 unknown 状态待确认（第 48 轮），不并入四态下结论。
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
    if (cancelled.kind === 'method-missing') {
      // 旧栈降级（第 46 轮口径）：无此读口才无从区分细分状态，
      // 保守归入从未落锁呈现
      return { status: 'never-locked', digest }
    }
    if (cancelled.kind === 'read-failed') {
      // 第 48 轮：读取失败 ≠ 没读口——状态待确认，不下结论
      return {
        status: 'unknown',
        digest,
        reason: `撤单状态读取失败（网络或节点异常）：${cancelled.error}。本次无法确认这张订单的链上状态，请稍后重新打开确认，不要重复提交。`,
      }
    }
    if (cancelled.value) {
      // 已永久关闭：区分「已全部成交」与「此前已撤单」
      const settlement =
        args.settlement ?? createSettlementFilledReader(args.signer)
      let filledIn: bigint
      try {
        filledIn = await settlement.orderFilledIn(digest)
      } catch (e) {
        // 第 48 轮：已成交量读取失败不得再默认 0n（会把已全部成交
        // 误报成已撤单）——状态待确认，不下结论
        return {
          status: 'unknown',
          digest,
          reason: `已成交量读取失败（网络或节点异常）：${e instanceof Error ? e.message : String(e)}。本次无法区分这张订单是已撤单还是已全部成交，请稍后重新打开确认，不要重复提交。`,
        }
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
  // 新栈再回读撤单墓碑：释放与置位同事务，读到「未置位」则不算
  // 完成（抛错）；旧栈没读口（method-missing）时跳过，与切换前
  // 行为一致；读取失败（第 48 轮）时锁定已释放是已确认事实、但
  // 墓碑状态没读到——按 unknown 待确认返回，不报 released 也不
  // 冒充失败，提示用户稍后重新确认。
  const cancelledAfter = await readCancelled(vault, digest)
  if (cancelledAfter.kind === 'value' && !cancelledAfter.value) {
    throw new Error('链上撤单已提交、锁定已释放，但回读未确认永久作废标记，请稍后在列表中确认状态')
  }
  if (cancelledAfter.kind === 'read-failed') {
    return {
      status: 'unknown',
      digest,
      reason: `链上撤单已提交、锁定已确认释放，但永久作废标记回读失败（网络或节点异常）：${cancelledAfter.error}。状态待确认，请稍后重新打开确认，不要重复提交。`,
    }
  }
  return { status: 'released', digest, txHash: tx.hash }
}
