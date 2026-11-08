/**
 * 撮合腿 → 链上 Fill 组装（阶段 3 块 C2）。
 *
 * 口径与节点 TradeToFill（node/internal/settlement/submit.go）逐项一致：
 * Fill 金额以 maker 视角记账——maker 卖（side=SELL）时 fill.tokenIn=
 * Token0、amountIn=qty0、amountOut=qty1；maker 买时 fill.tokenIn=Token1、
 * amountIn=qty1、amountOut=qty0，其中 qty1 = qty0 × maker 签名价 / 1e18。
 * 合约（阶段 3）会强制校验 fill 方向与双方签名 side 一致，填反必回滚，
 * 预检模拟（execute.ts）是第二道网。
 *
 * maker 的签名订单字段一律经 dualread 的 buildSignedOrderData 从簿行
 * 重构（与验签时同一份重构逻辑），不手抄字段；taker 订单由下单路径
 * 刚签出的 OrderData 直接传入。gasReimburse 双腿恒 0（与节点路径同：
 * 实际 gas 由合约按第 21 轮规则计量后对半扣减，不预填）。
 */
import { buildSignedOrderData } from '../dualread/digest'
import type { EvaluatedOrder } from '../dualread/types'
import type { OrderData } from '../orderSigningTypes'
import { SIDE_SELL } from '../orderSigningTypes'
import type { ContractFill, ContractOrder } from '../settlementService'
import type { MatchLeg } from './matcher'

export function orderDataToContractOrder(d: OrderData): ContractOrder {
  return {
    orderId: d.orderId,
    userAddress: d.userAddress,
    tokenIn: d.tokenIn,
    tokenOut: d.tokenOut,
    amountIn: BigInt(d.amountIn),
    amountOut: BigInt(d.amountOut),
    price: BigInt(d.price),
    timestamp: BigInt(d.timestamp),
    expiresAt: BigInt(d.expiresAt),
    nonce: BigInt(d.nonce),
    side: BigInt(d.side),
  }
}

export interface FillBuildContext {
  chainId: number
  /** 交易对 Token0/Token1（config/pairs 的 getPairTokens 结果） */
  token0: string
  token1: string
  takerData: OrderData
  takerSignature: string
  /** 本轮双读评估结果（按 orderId 索引 maker 的重构原料） */
  makersByOrderId: Map<string, EvaluatedOrder>
}

/**
 * 组装一腿的 Fill；maker 原料缺失/重构失败返回 null（调用方按剔腿
 * 处理并计数，不静默跳过）。
 */
export function buildLegFill(leg: MatchLeg, ctx: FillBuildContext): ContractFill | null {
  const makerEv = ctx.makersByOrderId.get(leg.makerOrderId)
  if (!makerEv) return null
  const rawCopy = makerEv.raw.node ?? makerEv.raw.relay
  if (!rawCopy) return null
  const makerData = buildSignedOrderData(rawCopy, ctx.chainId)
  if (!makerData) return null
  const makerOrder = orderDataToContractOrder(makerData)
  const takerOrder = orderDataToContractOrder(ctx.takerData)
  const makerSells = makerData.side === SIDE_SELL
  return {
    makerOrder: { order: makerOrder, signature: rawCopy.signature },
    takerOrder: { order: takerOrder, signature: ctx.takerSignature },
    tokenIn: makerSells ? ctx.token0 : ctx.token1,
    tokenOut: makerSells ? ctx.token1 : ctx.token0,
    amountIn: makerSells ? leg.qtyToken0 : leg.quoteAmount,
    amountOut: makerSells ? leg.quoteAmount : leg.qtyToken0,
    gasReimburseIn: 0n,
    gasReimburseOut: 0n,
  }
}

export function buildLegFills(
  legs: MatchLeg[],
  ctx: FillBuildContext,
): { fills: ContractFill[]; unbuildableLegs: number } {
  const fills: ContractFill[] = []
  let unbuildableLegs = 0
  for (const leg of legs) {
    const fill = buildLegFill(leg, ctx)
    if (fill) fills.push(fill)
    else unbuildableLegs += 1
  }
  return { fills, unbuildableLegs }
}
