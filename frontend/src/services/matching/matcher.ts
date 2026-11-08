/**
 * 前端本地撮合器（阶段 3 块 C1）——规则逐条移植节点撮合引擎
 * （node/internal/match/engine.go 的 Match / ExecuteMarketOrder /
 * DeriveAmountOut），不自创撮合规则：
 *
 * - 价格-时间优先：买盘价高者先、卖盘价低者先；同价按订单时间戳
 *   （createdAt）先到先得（节点 insertOrderSorted 同口径；时间戳再相同
 *   时前端以 orderId 字典序定序，保证纯函数确定性——节点簿内同时间戳
 *   的相对序由插入顺序决定，前端无从复现，故以 orderId 兜底，多源
 *   观察下同一输入必得同一输出）。
 * - 成交价 = maker 价（价格改善归 taker，与节点一致）。
 * - 成交量以 Token0 计：qty = min(taker 剩余, maker 剩余)；quote 量按
 *   整数公式 qty × price / 1e18（节点 DeriveAmountOut / 合约结算同式）。
 * - 限价：taker 买要求 maker 价 ≤ taker 限价、卖反之，触价即停。
 * - 市价：同一函数、taker 价 = 签名保护价即可（节点 ExecuteMarketOrder
 *   就是拿保护价当 taker 价调 Match 并 IOC 余量不入簿）——市价/限价
 *   在撮合层的唯一差别由调用方处理余量方式决定，不在本函数内分叉。
 * - 与节点的口径差（有意、写明）：跳过 taker 本人的挂单（自成交在节点
 *   引擎可发生，前端自提路径下自成交只会白付手续费与 gas 分成，无
 *   经济意义）；跳过剩余量 ≤ 0 的档位（节点在撮合循环内同样跳过并
 *   摘除，等价）。
 *
 * 纯函数、bigint 全程，不读时钟/网络——输入即同一双读可成交集时
 * 输出确定。骑乘：数量口径与 services/dualread 的 EvaluatedOrder
 * （remainingIn/Out）对接见 fromEvaluated.ts。
 */

export interface MatcherOrder {
  orderId: string
  trader: string
  side: 'buy' | 'sell'
  /** 签名价格（quote/Token0，1e18 定点 wei） */
  priceWei: bigint
  /** 剩余可成交量（Token0 wei） */
  remainingToken0: bigint
  /** 订单创建时间（秒，与签名 timestamp 同口径） */
  timestamp: number
}

export interface TakerIntent {
  trader: string
  side: 'buy' | 'sell'
  /** 限价单 = 限价；市价单 = 签名保护价 */
  priceWei: bigint
  /** 拟成交总量（Token0 wei） */
  amountToken0: bigint
}

export interface MatchLeg {
  makerOrderId: string
  makerTrader: string
  /** 成交价 = maker 签名价 */
  priceWei: bigint
  qtyToken0: bigint
  /** qtyToken0 × priceWei / 1e18（整数截断，与节点/合约一致） */
  quoteAmount: bigint
}

export interface MatchResult {
  legs: MatchLeg[]
  filledToken0: bigint
  /** 未成交余量（限价由调用方决定是否留簿，市价按 IOC 取消） */
  remainderToken0: bigint
}

const SCALE = 10n ** 18n

/** 节点 DeriveAmountOut 同式：quote = qty × price / 1e18（整数除） */
export function deriveQuoteAmount(qtyToken0: bigint, priceWei: bigint): bigint {
  return (qtyToken0 * priceWei) / SCALE
}

/** 价格-时间优先排序（就地排序副本，不改入参） */
export function sortMakersForTaker(
  takerSide: 'buy' | 'sell',
  makers: MatcherOrder[],
): MatcherOrder[] {
  const sorted = [...makers]
  sorted.sort((a, b) => {
    if (a.priceWei !== b.priceWei) {
      // taker 买 → 吃卖盘低价先；taker 卖 → 吃买盘高价先
      const cmp = a.priceWei < b.priceWei ? -1 : 1
      return takerSide === 'buy' ? cmp : -cmp
    }
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
    return a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0
  })
  return sorted
}

export function matchTaker(taker: TakerIntent, makers: MatcherOrder[]): MatchResult {
  const legs: MatchLeg[] = []
  let left = taker.amountToken0
  if (left <= 0n || taker.priceWei <= 0n) {
    return { legs, filledToken0: 0n, remainderToken0: left > 0n ? left : 0n }
  }
  const opposite = makers.filter(
    (m) =>
      m.side !== taker.side &&
      m.remainingToken0 > 0n &&
      m.trader.toLowerCase() !== taker.trader.toLowerCase(),
  )
  for (const maker of sortMakersForTaker(taker.side, opposite)) {
    if (left <= 0n) break
    const crosses =
      taker.side === 'buy' ? maker.priceWei <= taker.priceWei : maker.priceWei >= taker.priceWei
    if (!crosses) break // 已按价格排序：首个不触价即整体停止（节点同）
    const qty = left < maker.remainingToken0 ? left : maker.remainingToken0
    legs.push({
      makerOrderId: maker.orderId,
      makerTrader: maker.trader,
      priceWei: maker.priceWei,
      qtyToken0: qty,
      quoteAmount: deriveQuoteAmount(qty, maker.priceWei),
    })
    left -= qty
  }
  return { legs, filledToken0: taker.amountToken0 - left, remainderToken0: left }
}
