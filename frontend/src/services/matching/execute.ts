/**
 * 前端撮合执行编排（阶段 3 块 C1–C3）：
 *
 *   新鲜双读一轮（当前交易对）→ 可成交集 → 本地撮合（matcher.ts）
 *   → 组装 Fill（fills.ts）→ 档位上限截断（prune.ts）
 *   → 双方落锁补齐（Vault.lockForOrder 无许可 L2：结算前由提交者补锁，
 *     方向只从签名 side 派生——阶段 3 新签名）
 *   → 整批预检模拟 + 陈旧腿剔除（prune.ts）→ 用户钱包自提批结算
 *     （settleTradesBatch，开放提交 B 模型，整批原子）
 *
 * 失败口径（给用户的 message 均为完整句子，不抛裸异常）：
 * - 无对手可成交 / 撮合无腿 → no-match：订单已广播留簿。
 * - 全部腿预检不过或整批模拟仍失败 → aborted：整单不提交（原子性
 *   底线），订单留簿，失败原因附在 message 里。
 * - 部分腿被剔 → submitted 并注明剔除腿数（陈旧腿=已被其他通道成交/
 *   过期/锁释放，剔除后成交的部分是真实最新状态）。
 *
 * 本模块只在灰度开关开启时被下单路径调用（config/matching.ts）；
 * 关闭时下单路径零变化。
 */
import { ethers } from 'ethers'
import { getPairTokens } from '../../config/pairs'
import { getChainConfig } from '../../config/chains'
import { runBookRound, type DualReadDeps } from '../dualread'
import { computeOrderDigest } from '../dualread/digest'
import type { EvaluatedOrder } from '../dualread/types'
import type { OrderData } from '../orderSigningTypes'
import { SETTLEMENT_ABI } from '../settlementAbi'
import { VAULT_LOCK_ABI } from '../vaultAbi'
import type { ContractFill } from '../settlementService'
import { matchTaker, type TakerIntent } from './matcher'
import { toMatcherOrders } from './fromEvaluated'
import { buildLegFills, orderDataToContractOrder } from './fills'
import { simulateAndPrune, capLegs, errText } from './prune'

export interface FrontendMatchRequest {
  chainId: number
  pair: string
  takerData: OrderData
  takerSignature: string
  signer: ethers.Signer
}

export interface FrontendMatchOutcome {
  status: 'submitted' | 'no-match' | 'aborted'
  /** 用户可见口径（中文完整句） */
  message: string
  txHash?: string
  legsKept: number
  legsPruned: number
  /** 因档位上限未进本批的腿数（余量未成交） */
  legsOverflow: number
  filledToken0: string
  remainderToken0: string
}

const NO_MATCH_MSG = '当前对手盘暂无可成交订单，订单已留簿。'

function vaultContract(chainId: number, runner: ethers.ContractRunner) {
  const cfg = getChainConfig(chainId)
  if (!cfg) throw new Error(`chain ${chainId} not configured`)
  return new ethers.Contract(cfg.contracts.vault, VAULT_LOCK_ABI, runner)
}

function settlementContract(chainId: number, runner: ethers.ContractRunner) {
  const cfg = getChainConfig(chainId)
  if (!cfg) throw new Error(`chain ${chainId} not configured`)
  return new ethers.Contract(cfg.contracts.settlement, SETTLEMENT_ABI, runner)
}

/** 订单是否已有活跃锁（orderLocks 的 remaining > 0） */
async function hasActiveLock(
  vault: ethers.Contract,
  data: OrderData,
  chainId: number,
): Promise<boolean> {
  const digest = computeOrderDigest(data, chainId)
  const lock = await vault.orderLocks(digest)
  return BigInt(lock.remaining ?? lock[2] ?? 0n) > 0n
}

async function ensureLock(
  vault: ethers.Contract,
  data: OrderData,
  signature: string,
  chainId: number,
): Promise<void> {
  if (await hasActiveLock(vault, data, chainId)) return
  const tx = await vault.lockForOrder(orderDataToContractOrder(data), signature)
  await tx.wait()
}

export async function executeFrontendMatch(
  req: FrontendMatchRequest,
  // 第二参沿用 DualReadDeps 兼容形状：第 51 轮起内部走中继单源
  // runBookRound，deps 里的 nodeAdapter/mode 等旧字段被忽略（阶段 4
  // 验收运行器 scripts/stage4 仍按旧形状传参）。
  dualReadDeps?: Partial<DualReadDeps>,
): Promise<FrontendMatchOutcome> {
  const { chainId, pair, takerData, takerSignature, signer } = req
  const zero = { legsKept: 0, legsPruned: 0, legsOverflow: 0, filledToken0: '0', remainderToken0: takerData.amountIn }
  const tokens = getPairTokens(chainId, pair)
  if (!tokens) {
    return { status: 'aborted', message: `交易对 ${pair} 未登记代币地址，无法前端撮合；订单已留簿。`, ...zero }
  }

  // 1) 新鲜中继簿一轮 → 可成交集（认证只认逐单签名证明 + 链上状态，见 fromEvaluated）
  let tradeable: EvaluatedOrder[] = []
  try {
    const round = await runBookRound({ ...dualReadDeps }, chainId, [pair])
    const view = round.views.find((v) => v.pair === pair)
    tradeable = view?.tradeable ?? []
  } catch {
    return { status: 'no-match', message: NO_MATCH_MSG, ...zero }
  }
  const makers = toMatcherOrders(tradeable)
  if (makers.length === 0) return { status: 'no-match', message: NO_MATCH_MSG, ...zero }

  // 2) 本地撮合（限价/市价同路径：市价的 taker 价即签名保护价）
  const intent: TakerIntent = {
    trader: takerData.userAddress,
    side: takerData.side === 1 ? 'sell' : 'buy',
    priceWei: BigInt(takerData.price),
    amountToken0: BigInt(takerData.amountIn),
  }
  const matched = matchTaker(intent, makers)
  if (matched.legs.length === 0) {
    return {
      status: 'no-match',
      message: NO_MATCH_MSG,
      ...zero,
      remainderToken0: matched.remainderToken0.toString(),
    }
  }

  // 3) 档位上限截断 + 组装 Fill
  const { capped, overflow } = capLegs(matched.legs)
  const makersByOrderId = new Map(tradeable.map((o) => [o.orderId, o]))
  const { fills, unbuildableLegs } = buildLegFills(capped, {
    chainId,
    token0: tokens.base,
    token1: tokens.quote,
    takerData,
    takerSignature,
    makersByOrderId,
  })
  if (fills.length === 0) {
    return {
      status: 'aborted',
      message: '对手订单数据无法组装结算（可能已变更），整单未提交；订单已留簿。',
      ...zero,
      legsPruned: unbuildableLegs,
      legsOverflow: overflow,
      remainderToken0: matched.remainderToken0.toString(),
    }
  }

  const settlement = settlementContract(chainId, signer)
  const vault = vaultContract(chainId, signer)

  // 4) 落锁补齐：taker 本人订单 + 每腿 maker 订单（无许可，方向由签名派生）
  try {
    await ensureLock(vault, takerData, takerSignature, chainId)
    const seen = new Set<string>()
    for (const fill of fills) {
      const mo = fill.makerOrder
      const key = mo.order.orderId
      if (seen.has(key)) continue
      seen.add(key)
      const makerData: OrderData = {
        orderId: mo.order.orderId,
        userAddress: mo.order.userAddress,
        tokenIn: mo.order.tokenIn,
        tokenOut: mo.order.tokenOut,
        amountIn: mo.order.amountIn.toString(),
        amountOut: mo.order.amountOut.toString(),
        price: mo.order.price.toString(),
        timestamp: Number(mo.order.timestamp),
        expiresAt: Number(mo.order.expiresAt),
        nonce: Number(mo.order.nonce),
        side: Number(mo.order.side),
      }
      await ensureLock(vault, makerData, mo.signature, chainId)
    }
  } catch (e) {
    return {
      status: 'aborted',
      message: `落锁补齐失败（${errText(e).slice(0, 120)}），整单未提交；订单已留簿。`,
      ...zero,
      legsOverflow: overflow,
      remainderToken0: matched.remainderToken0.toString(),
    }
  }

  // 5) 预检模拟 + 剔腿（整批 → 逐腿 → 整批；仍不过则整单不提交）
  const outcome = await simulateAndPrune<ContractFill>(
    fills,
    async (batch) => {
      await settlement.settleTradesBatch.staticCall(batch)
    },
    async (one) => {
      try {
        await settlement.settleTrade.staticCall(one)
        return null
      } catch (e) {
        return errText(e)
      }
    },
  )
  if (!outcome.batchSimOk || outcome.kept.length === 0) {
    return {
      status: 'aborted',
      message:
        '预检模拟未通过（对手订单可能刚被成交或已过期），为保证整批原子性本单未提交；订单已留簿。',
      ...zero,
      legsPruned: outcome.pruned.length + unbuildableLegs,
      legsOverflow: overflow,
      remainderToken0: matched.remainderToken0.toString(),
    }
  }

  // 6) 自提批结算（整批原子；失败 gas 由提交者自担，与发起者自担口径一致）
  // gasLimit 显式加 25% 缓冲：块 D 对照实测 ethers/钱包的 estimateGas 对
  // 本批结算存在低估（anvil 上静态模拟通过、按估算值发送却 OOG 回滚），
  // 不把估算值当上限用。
  try {
    const estimated = await settlement.settleTradesBatch.estimateGas(outcome.kept)
    const tx = await settlement.settleTradesBatch(outcome.kept, {
      gasLimit: (estimated * 125n) / 100n,
    })
    const receipt = await tx.wait()
    const keptQty = outcome.kept.reduce(
      (acc, f) => acc + (f.makerOrder.order.side === 1n ? f.amountIn : f.amountOut),
      0n,
    )
    return {
      status: 'submitted',
      message:
        outcome.pruned.length > 0
          ? `前端撮合已上链结算 ${outcome.kept.length} 笔（${outcome.pruned.length} 笔对手订单已失效被剔除）。`
          : `前端撮合已上链结算 ${outcome.kept.length} 笔。`,
      txHash: receipt?.hash ?? tx.hash,
      legsKept: outcome.kept.length,
      legsPruned: outcome.pruned.length + unbuildableLegs,
      legsOverflow: overflow,
      filledToken0: keptQty.toString(),
      remainderToken0: (BigInt(takerData.amountIn) - keptQty).toString(),
    }
  } catch (e) {
    return {
      status: 'aborted',
      message: `批结算提交失败（${errText(e).slice(0, 120)}）；订单已留簿。`,
      ...zero,
      legsPruned: outcome.pruned.length + unbuildableLegs,
      legsOverflow: overflow,
      remainderToken0: matched.remainderToken0.toString(),
    }
  }
}
