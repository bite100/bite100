/**
 * 最低交易额校验（第六十轮落地，Ren 2026-11-08 拍板 $1）：下单侧按美元
 * 等值估算本单价值，下限 1 美元。估算锚的优先级（第 60 轮文档 §4）：
 * ① 有美元计价参考价（Chainlink USD 喂价 / DexScreener 推导）→ 数量 × 参考价；
 * ② 计价币是美元稳定币（USDT/USDC/DAI/TUSD）→ 数量 × 本单价格（≈美元）；
 * ③ 无美元锚 → 按本单价格的计价币面值与 1 比较（口径如实，界面注明「暂无
 *    美元参考价，按计价币面值校验最低额」），绝不编造汇率。
 * 市价单的价格取其保护价（与签名口径一致）。
 */

/** 最低下单额（美元等值） */
export const MIN_ORDER_USD = 1

export const USD_STABLE_SYMBOLS = ['USDT', 'USDC', 'DAI', 'TUSD'] as const

export function isUsdStableSymbol(symbol: string): boolean {
  return (USD_STABLE_SYMBOLS as readonly string[]).includes(symbol.toUpperCase())
}

export type MinOrderBasis = 'referenceUsd' | 'stableQuote' | 'quoteFace' | 'none'

export interface MinOrderInput {
  /** 本单数量（base 人类单位） */
  amount: number
  /** 本单价格（quote/base 人类单位；市价单 = 保护价） */
  orderPrice: number
  /** 计价币符号 */
  quoteSymbol: string
  /** 参考价（quote/base 人类单位）；无参考为 null */
  refPrice: number | null
  /** 参考价是否美元计价（Chainlink USD 喂价 / DexScreener 推导为 true；盘口中间价/最近成交为 false） */
  refUsdDenominated: boolean
}

export interface MinOrderResult {
  pass: boolean
  /** 估算的美元等值；无美元锚（quoteFace）时为 null */
  usdValue: number | null
  /** 实际使用的估算口径 */
  basis: MinOrderBasis
}

export function evaluateMinOrder(input: MinOrderInput): MinOrderResult {
  const { amount, orderPrice, quoteSymbol, refPrice, refUsdDenominated } = input
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(orderPrice) || orderPrice <= 0) {
    return { pass: false, usdValue: null, basis: 'none' }
  }
  const EPS = 1e-9
  if (refPrice !== null && refPrice > 0 && refUsdDenominated) {
    const usdValue = amount * refPrice
    return { pass: usdValue >= MIN_ORDER_USD - EPS, usdValue, basis: 'referenceUsd' }
  }
  if (isUsdStableSymbol(quoteSymbol)) {
    const usdValue = amount * orderPrice
    return { pass: usdValue >= MIN_ORDER_USD - EPS, usdValue, basis: 'stableQuote' }
  }
  // 无美元锚：按计价币面值比较（amount × orderPrice 的单位是计价币）
  const face = amount * orderPrice
  return { pass: face >= 1 - EPS, usdValue: null, basis: 'quoteFace' }
}

/** 未达最低额时的报错文案（口径随 basis 变化，不编造美元数） */
export function minOrderErrorMessage(result: MinOrderResult): string {
  if (result.basis === 'quoteFace') {
    return '本单金额低于最低交易额：该交易对暂无美元参考价，按计价币面值需达到 1 以上，请加大数量或价格'
  }
  const usd = result.usdValue !== null ? `（约 $${result.usdValue.toFixed(2)}）` : ''
  return `本单金额低于最低交易额 $1${usd}，请加大数量或价格`
}
