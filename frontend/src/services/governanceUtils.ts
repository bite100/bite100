/**
 * 治理相关工具：手续费百分比转 bps、提案参数校验
 */

/**
 * 将手续费百分比转为 bps（万分之一）
 * 例：0.08 -> 8, 1 -> 100
 */
export function feePercentToBps(percent: string): number | null {
  const p = parseFloat(percent)
  if (!Number.isFinite(p) || p <= 0 || p > 100) return null
  const bps = Math.round(p * 100)
  if (bps < 1 || bps > 10000) return null
  return bps
}

/**
 * 校验提案手续费输入，返回错误信息或 null
 */
export function validateProposalFeePercent(percent: string): string | null {
  if (!percent.trim()) return '请输入手续费比例'
  const bps = feePercentToBps(percent)
  if (bps === null) return '手续费比例需在 0.01～100 之间'
  return null
}
