/**
 * 代币/Vault 操作小工具（第 31 轮从 App 抽出，资产页与金库页共用）：
 * - ensureAllowance：授权不足时先清零再授权（避免某些 ERC20 的非标准行为），与原 App 口径一致；
 * - parseAmountInput：人类单位数量 → wei（18 位，与本站代币统一精度口径一致）。
 */
import type { Contract } from 'ethers'

export async function ensureAllowance(
  token: Contract,
  owner: string,
  spender: string,
  amount: bigint,
): Promise<void> {
  const current = (await token.allowance(owner, spender)) as bigint
  if (current >= amount) return
  if (current > 0n) {
    await (await token.approve(spender, 0n)).wait()
  }
  await (await token.approve(spender, amount)).wait()
}

export function parseAmountInput(s: string): bigint {
  const n = parseFloat(s)
  if (Number.isNaN(n) || n < 0) return 0n
  return BigInt(Math.floor(n * 1e18))
}
