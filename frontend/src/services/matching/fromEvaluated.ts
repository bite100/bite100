/**
 * 双读可成交集 → 撮合器输入（阶段 3 块 C1 的骑乘接缝）。
 *
 * 输入只认 dualread 的可成交集（mergeBooks 的 view.tradeable：VALID +
 * 逐单方向证明通过 + 未终局），本模块只做数量口径换算，不重复任何
 * 有效性判定——撮合永远只吃已认证订单，这是阶段 3 的硬接缝。
 *
 * 剩余量换算（Token0 口径）：链上累计成交按 maker 付款视角记账
 * （节点 TradeToFill / 合约 orderFilledIn 同口径）：
 * - SELL maker：付款 Token0，filledIn 即 Token0 已成交 →
 *   剩余 = remainingIn（evaluate 已算）。
 * - BUY maker：付款 Token1（quote）、收款 Token0，filledOut 记的是
 *   已收到的 Token0 量；evaluate 的 remainingOut 是按签名 amountOut
 *   （quote 总额）减 filledOut 得到的——故已成交 Token0 量
 *   filledOut = amountOut − remainingOut，剩余 Token0 =
 *   amountIn − filledOut = amountIn − amountOut + remainingOut。
 *   全部 bigint 精确运算，无浮点。
 */
import type { EvaluatedOrder } from '../dualread/types'
import type { MatcherOrder } from './matcher'

function bi(s: string): bigint {
  try {
    return BigInt(s)
  } catch {
    return 0n
  }
}

export function makerRemainingToken0(o: EvaluatedOrder): bigint {
  if (o.side === 'sell') return bi(o.remainingIn)
  const filledOut = bi(o.amountOut) - bi(o.remainingOut)
  const remaining = bi(o.amountIn) - filledOut
  return remaining > 0n ? remaining : 0n
}

export function toMatcherOrder(o: EvaluatedOrder): MatcherOrder {
  return {
    orderId: o.orderId,
    trader: o.trader,
    side: o.side,
    priceWei: bi(o.price),
    remainingToken0: makerRemainingToken0(o),
    timestamp: o.timestamp,
  }
}

export function toMatcherOrders(tradeable: EvaluatedOrder[]): MatcherOrder[] {
  return tradeable.map(toMatcherOrder).filter((m) => m.remainingToken0 > 0n)
}
