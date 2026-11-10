/**
 * gas库（GasVault）索引纯逻辑（第 63 轮 gas-2）。
 *
 * 实体 ID 与 Trade/GasShare 同口径：chainId-txHash-logIndex（小写 txHash）。
 * 事件 → GasVaultFlow 字段的映射口径集中在这里，handler 只做取值与落库，
 * 便于合成事件测试与纯逻辑单测双重覆盖。
 */

export function gasVaultEntityId(chainId: number, txHash: string, logIndex: number): string {
  return `${chainId}-${txHash.toLowerCase()}-${logIndex}`
}

export type GasVaultFlowShape = {
  kind: string
  actor: string
  counterparty: string | undefined
  token: string | undefined
  amount: bigint
  secondaryAmount: bigint | undefined
  claimId: string | undefined
}

const lower = (a: string) => a.toLowerCase()

/** ERC-4626 Deposit(sender, owner, assets, shares) */
export function depositFlow(args: {
  sender: string
  owner: string
  assets: bigint
  shares: bigint
}): GasVaultFlowShape {
  return {
    kind: 'deposit',
    actor: lower(args.sender),
    counterparty: lower(args.owner),
    token: undefined,
    amount: args.assets,
    secondaryAmount: args.shares,
    claimId: undefined,
  }
}

/** ERC-4626 Withdraw(sender, receiver, owner, assets, shares) */
export function withdrawFlow(args: {
  sender: string
  receiver: string
  assets: bigint
  shares: bigint
}): GasVaultFlowShape {
  return {
    kind: 'withdraw',
    actor: lower(args.sender),
    counterparty: lower(args.receiver),
    token: undefined,
    amount: args.assets,
    secondaryAmount: args.shares,
    claimId: undefined,
  }
}

/** ConversionTriggered(caller, tokenIn, amountIn, assetReceived, minOut) */
export function conversionFlow(args: {
  caller: string
  tokenIn: string
  amountIn: bigint
  assetReceived: bigint
}): GasVaultFlowShape {
  return {
    kind: 'conversion',
    actor: lower(args.caller),
    counterparty: undefined,
    token: lower(args.tokenIn),
    amount: args.amountIn,
    secondaryAmount: args.assetReceived,
    claimId: undefined,
  }
}

/** ShortfallAbsorbed(claimId, beneficiary, amount, measurer) */
export function shortfallFlow(args: {
  claimId: string
  beneficiary: string
  amount: bigint
  measurer: string
}): GasVaultFlowShape {
  return {
    kind: 'shortfall',
    actor: lower(args.beneficiary),
    counterparty: lower(args.measurer),
    token: undefined,
    amount: args.amount,
    secondaryAmount: undefined,
    claimId: args.claimId.toLowerCase(),
  }
}

/** FloatFunded(from, amount) */
export function floatFundedFlow(args: { from: string; amount: bigint }): GasVaultFlowShape {
  return {
    kind: 'float-funded',
    actor: lower(args.from),
    counterparty: undefined,
    token: undefined,
    amount: args.amount,
    secondaryAmount: undefined,
    claimId: undefined,
  }
}
