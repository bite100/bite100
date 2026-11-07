/**
 * 做市金库份额口径（第 31 轮，纯函数，单位均为人类单位数字）：
 * - NAV（每份净值）= 总资产 / 总份额（金库空仓时按 ERC-4626 初始 1:1）；
 * - 我的市值 = 我的份额 × NAV；
 * - 我的可提份额：赎回只能动用「金库自有 USDT + 交易 Vault 可用额」这部分流动计价资产，
 *   可提份额 = min(我的份额, 流动计价资产 / NAV)；挂单占用的部分要等成交/撤单释放；
 * - 挂单占用对应份额 = (交易 Vault 锁定中的计价额 + 基础币锁定按金库喂价折算) / NAV。
 */

export interface MakerVaultFigures {
  totalAssets: number
  totalShares: number
  myShares: number
  /** 金库当前可立即动用的计价资产（自有 USDT 余额 + 交易 Vault 可用额） */
  liquidQuote: number
  /** 交易 Vault 中被做市挂单锁定的计价资产折算额（含基础币按喂价折算） */
  lockedQuoteValue: number
}

export interface MakerVaultDerived {
  nav: number
  myValue: number
  redeemableShares: number
  lockedShares: number
}

export function deriveMakerVaultFigures(f: MakerVaultFigures): MakerVaultDerived {
  const nav = f.totalShares > 0 ? f.totalAssets / f.totalShares : 1
  const myValue = f.myShares * nav
  const redeemableByLiquidity = nav > 0 ? f.liquidQuote / nav : 0
  const redeemableShares = Math.max(0, Math.min(f.myShares, redeemableByLiquidity))
  const lockedShares = nav > 0 ? Math.max(0, f.lockedQuoteValue / nav) : 0
  return { nav, myValue, redeemableShares, lockedShares }
}

/** 预计获得份额（存入页）：按当前 NAV 折算；空金库 1:1 */
export function estimateSharesForDeposit(amountQuote: number, totalAssets: number, totalShares: number): number {
  if (amountQuote <= 0) return 0
  if (totalShares <= 0 || totalAssets <= 0) return amountQuote
  return (amountQuote * totalShares) / totalAssets
}

/** 预计赎回金额（提取页）：份额 × NAV */
export function estimateQuoteForShares(shares: number, totalAssets: number, totalShares: number): number {
  if (shares <= 0) return 0
  if (totalShares <= 0) return shares
  return (shares * totalAssets) / totalShares
}
