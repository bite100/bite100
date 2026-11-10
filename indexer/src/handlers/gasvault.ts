/**
 * GasVault（gas库）资金流索引 handler（第 63 轮 gas-2，Envio HyperIndex v3）。
 *
 * 事件集合（枚举自 contracts/src/GasVault.sol 的全部资金流事件）：
 * - Deposit / Withdraw（OZ ERC-4626 标准事件）：存款人存取。
 * - ConversionTriggered：公开触发的库存换汇补油箱（熔断线内的成功换汇才上链）。
 * - ShortfallAbsorbed：计量人证明驱动的短缺吸收付款。
 * - FloatFunded：原生币浮存注资。
 * 字段映射口径在 src/lib/gasvault.ts（纯逻辑，可单测）；本文件只取值落库。
 * 池子状态（总资产/水位/份额价）不在索引重算——前端直读合约，链是唯一账本。
 */
import { indexer } from 'envio'
import type { EvmEvent, EvmEventWithFields, EvmOnEventContext } from 'envio'
import {
  gasVaultEntityId,
  depositFlow,
  withdrawFlow,
  conversionFlow,
  shortfallFlow,
  floatFundedFlow,
  type GasVaultFlowShape,
} from '../lib/gasvault'

const FIELDS = {
  transaction: ['hash'],
  block: ['number', 'timestamp'],
} as const

type Ctx = EvmOnEventContext
type GasEventBase = {
  chainId: number
  srcAddress: string
  logIndex: number
  transaction: { hash: string }
  block: { number: number; timestamp: number }
}

async function saveFlow(event: GasEventBase, context: Ctx, shape: GasVaultFlowShape) {
  await context.GasVaultFlow.set({
    id: gasVaultEntityId(event.chainId, event.transaction.hash, event.logIndex),
    contractAddress: event.srcAddress.toLowerCase(),
    txHash: event.transaction.hash.toLowerCase(),
    logIndex: event.logIndex,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    ...shape,
  })
}

type DepositEvent = EvmEventWithFields<EvmEvent<'GasVault', 'Deposit'>, typeof FIELDS>
type WithdrawEvent = EvmEventWithFields<EvmEvent<'GasVault', 'Withdraw'>, typeof FIELDS>
type ConversionEvent = EvmEventWithFields<EvmEvent<'GasVault', 'ConversionTriggered'>, typeof FIELDS>
type ShortfallEvent = EvmEventWithFields<EvmEvent<'GasVault', 'ShortfallAbsorbed'>, typeof FIELDS>
type FloatFundedEvent = EvmEventWithFields<EvmEvent<'GasVault', 'FloatFunded'>, typeof FIELDS>

indexer.onEvent(
  { contract: 'GasVault', event: 'Deposit', fields: FIELDS },
  async ({ event, context }: { event: DepositEvent; context: Ctx }) => {
    const a = event.params
    await saveFlow(
      event,
      context,
      depositFlow({ sender: a.sender, owner: a.owner, assets: a.assets, shares: a.shares })
    )
  }
)

indexer.onEvent(
  { contract: 'GasVault', event: 'Withdraw', fields: FIELDS },
  async ({ event, context }: { event: WithdrawEvent; context: Ctx }) => {
    const a = event.params
    await saveFlow(
      event,
      context,
      withdrawFlow({ sender: a.sender, receiver: a.receiver, assets: a.assets, shares: a.shares })
    )
  }
)

indexer.onEvent(
  { contract: 'GasVault', event: 'ConversionTriggered', fields: FIELDS },
  async ({ event, context }: { event: ConversionEvent; context: Ctx }) => {
    const a = event.params
    await saveFlow(
      event,
      context,
      conversionFlow({
        caller: a.caller,
        tokenIn: a.tokenIn,
        amountIn: a.amountIn,
        assetReceived: a.assetReceived,
      })
    )
  }
)

indexer.onEvent(
  { contract: 'GasVault', event: 'ShortfallAbsorbed', fields: FIELDS },
  async ({ event, context }: { event: ShortfallEvent; context: Ctx }) => {
    const a = event.params
    await saveFlow(
      event,
      context,
      shortfallFlow({ claimId: a.claimId, beneficiary: a.beneficiary, amount: a.amount, measurer: a.measurer })
    )
  }
)

indexer.onEvent(
  { contract: 'GasVault', event: 'FloatFunded', fields: FIELDS },
  async ({ event, context }: { event: FloatFundedEvent; context: Ctx }) => {
    const a = event.params
    await saveFlow(event, context, floatFundedFlow({ from: a.from, amount: a.amount }))
  }
)
