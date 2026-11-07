/**
 * 下单时一键补存 Vault 差额（第十七轮 Part D）：
 * 结算与挂单锁定都走 Vault 余额——下单前先算本单义务所需的 Vault 可用额，
 * 不足时在本面板内完成「授权（如需）→ 存入恰好差额 → 回读确认到账」，
 * 然后才继续签名提交。任一步失败都抛错停在下单前，绝不带着不足的余额签名。
 * 本模块只含纯计算与可注入依赖的流程编排，便于单测；链上读写由调用方注入。
 */

/** 本单义务（wei）：卖单锁 amountIn 的卖出币；买单按价格锁 amountIn×价格/1e18 的买入币。与节点/合约的 ObligationForOrder 口径一致。 */
export function orderObligationWei(side: 'buy' | 'sell', amountInWei: bigint, priceWei: bigint): bigint {
  if (side === 'sell') return amountInWei
  return (amountInWei * priceWei) / 1000000000000000000n
}

/** 差额（wei）：可用额不足义务的部分；充足为 0 */
export function shortfallWei(requiredWei: bigint, availableWei: bigint): bigint {
  return requiredWei > availableWei ? requiredWei - availableWei : 0n
}

export type VaultTopUpStep = 'approving' | 'depositing' | 'verifying'

export type VaultTopUpErrorKind =
  | 'wallet-insufficient' // 钱包余额连差额都不够补
  | 'topup-rejected' // 用户在钱包中拒绝了授权/存入
  | 'topup-failed' // 授权/存入交易失败
  | 'still-insufficient' // 补存已上链但回读可用额仍不足（异常状态）

export class VaultTopUpError extends Error {
  kind: VaultTopUpErrorKind
  shortfallWei: bigint
  constructor(kind: VaultTopUpErrorKind, message: string, shortfallWei: bigint) {
    super(message)
    this.name = 'VaultTopUpError'
    this.kind = kind
    this.shortfallWei = shortfallWei
  }
}

export interface VaultTopUpDeps {
  /** 当前对 Vault 的授权额度（wei） */
  allowance: () => Promise<bigint>
  /** 授权恰好 amount（wei）给 Vault；等待上链完成才 resolve */
  approve: (amount: bigint) => Promise<void>
  /** 向 Vault 存入 amount（wei）；等待上链确认才 resolve */
  deposit: (amount: bigint) => Promise<void>
  /** 回读 Vault 可用余额（wei） */
  available: () => Promise<bigint>
}

function isUserRejection(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  const code = (e as { code?: unknown })?.code
  return (
    code === 'ACTION_REJECTED' ||
    /user rejected|user denied|rejected the request|denied transaction/i.test(msg)
  )
}

export interface EnsureVaultBalanceResult {
  /** 是否实际执行了补存 */
  toppedUp: boolean
  /** 补存的差额（wei）；无需补存为 0 */
  shortfallWei: bigint
}

/**
 * 确保 Vault 可用额 ≥ 本单义务：
 * - 充足：不触发任何链上操作，直接返回；
 * - 不足但钱包够：授权（如需）→ 存入差额 → 回读确认；
 * - 钱包不够 / 补存被拒或失败 / 回读仍不足：抛 VaultTopUpError，调用方必须中止下单。
 */
export async function ensureVaultBalance(opts: {
  requiredWei: bigint
  availableWei: bigint
  walletWei: bigint
  deps: VaultTopUpDeps
  onStep?: (step: VaultTopUpStep) => void
}): Promise<EnsureVaultBalanceResult> {
  const { requiredWei, availableWei, walletWei, deps, onStep } = opts
  const shortfall = shortfallWei(requiredWei, availableWei)
  if (shortfall <= 0n) return { toppedUp: false, shortfallWei: 0n }

  if (walletWei < shortfall) {
    throw new VaultTopUpError(
      'wallet-insufficient',
      '钱包余额不足，连差额都补不齐：请先向钱包充值，或减小下单数量。',
      shortfall
    )
  }

  try {
    const allowance = await deps.allowance()
    if (allowance < shortfall) {
      onStep?.('approving')
      await deps.approve(shortfall)
    }
    onStep?.('depositing')
    await deps.deposit(shortfall)
  } catch (e) {
    if (e instanceof VaultTopUpError) throw e
    if (isUserRejection(e)) {
      throw new VaultTopUpError(
        'topup-rejected',
        '你已在钱包中取消补存，本次下单未提交。补存完成后才能下单。',
        shortfall
      )
    }
    throw new VaultTopUpError(
      'topup-failed',
      '补存交易失败，本次下单未提交。请检查网络与钱包状态后重试。',
      shortfall
    )
  }

  onStep?.('verifying')
  const after = await deps.available()
  if (after < requiredWei) {
    throw new VaultTopUpError(
      'still-insufficient',
      '补存已完成，但回读的 Vault 可用余额仍不足以覆盖本单义务，已停止下单。请到资产页确认余额后重试。',
      shortfallWei(requiredWei, after)
    )
  }
  return { toppedUp: true, shortfallWei: shortfall }
}
