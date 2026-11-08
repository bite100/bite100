/**
 * Settlement 成交索引 handler（第 34 轮，Envio HyperIndex v3）。
 *
 * 事件集合（枚举自 contracts/src/Settlement.sol 现行结算路径，防漏记/重复记账）：
 * - TradeSettled / TradeSettledWithGasReimburse：_settleInternal 的互斥二选一
 *   分支，每 Fill 恰好发射其一 → 每笔成交恰好一行 Trade。
 * - GasCostShared：每 Fill 结算落地后由 _chargeGasForFill 发射一次（gas 对半
 *   回收明细）→ GasShare 一行，按同 tx 顺序 + maker/taker 双核对关联 Trade。
 * - 不索引：TradesBatchSettledWithMerkle / GasSavingsDistributed（批次级聚合，
 *   与逐笔行重复记账风险）、FailedSettlementCharged（失败扣费，非成交）、
 *   其余治理/配置事件（与成交无关）。
 *
 * digest 关联：handler 经 fields 选项取 transaction.input（v3.7+），
 * 纯逻辑在 src/lib/association.ts（解码 + 按序对应 + 规范重算），解不出留空。
 */
import { indexer } from 'envio'
import {
  decodeSettleCalldata,
  digestsForFillIndex,
  gasShareEntityId,
  tradeEntityId,
} from '../lib/association'

const TRADE_FIELDS = { transaction: ['hash', 'input', 'from'] } as const
const GAS_FIELDS = { transaction: ['hash'] } as const

type TradeEvent = {
  chainId: number
  srcAddress: string
  logIndex: number
  block: { number: number; timestamp: number; hash: string }
  transaction: { hash: string; input?: string }
  params: {
    maker: string
    taker: string
    tokenIn: string
    tokenOut: string
    amountIn: bigint
    amountOut: bigint
    feeAmount: bigint
    gasReimburseIn?: bigint
    gasReimburseOut?: bigint
    gasRecipient?: string
  }
}

type GasEvent = {
  chainId: number
  srcAddress: string
  logIndex: number
  block: { number: number; timestamp: number; hash: string }
  transaction: { hash: string }
  params: {
    maker: string
    taker: string
    gasRecipient: string
    gasUsed: bigint
    gasCostWei: bigint
    reason: number | bigint
    makerToken: string
    makerDeduct: bigint
    makerShortfall: bigint
    takerToken: string
    takerDeduct: bigint
    takerShortfall: bigint
  }
}

// context 的实体面由 envio codegen 按 schema.graphql 生成；此处只声明用到的形状
type Ctx = {
  Trade: {
    get: (id: string) => Promise<{ maker: string; taker: string } | undefined>
    set: (entity: Record<string, unknown>) => void
  }
  GasShare: { set: (entity: Record<string, unknown>) => void }
  TxCursor: {
    get: (id: string) => Promise<{ id: string; tradeIds: string[]; gasCount: number } | undefined>
    set: (entity: { id: string; tradeIds: string[]; gasCount: number }) => void
  }
}

async function handleTrade(event: TradeEvent, context: Ctx, eventKind: string) {
  const txHash = event.transaction.hash
  const id = tradeEntityId(event.chainId, txHash, event.logIndex)
  const cursor = (await context.TxCursor.get(txHash)) ?? {
    id: txHash,
    tradeIds: [],
    gasCount: 0,
  }
  // 第 N 个成交事件 ↔ calldata 第 N 个 Fill（N = 本 tx 已处理成交数）
  const fills = decodeSettleCalldata(event.transaction.input)
  const digests = digestsForFillIndex(
    fills,
    cursor.tradeIds.length,
    event.chainId,
    event.srcAddress,
  )
  context.Trade.set({
    id,
    contractAddress: event.srcAddress,
    txHash,
    logIndex: event.logIndex,
    blockNumber: event.block.number,
    blockHash: event.block.hash,
    blockTimestamp: event.block.timestamp,
    eventKind,
    maker: event.params.maker,
    taker: event.params.taker,
    tokenIn: event.params.tokenIn,
    tokenOut: event.params.tokenOut,
    amountIn: event.params.amountIn,
    amountOut: event.params.amountOut,
    feeAmount: event.params.feeAmount,
    gasReimburseIn: event.params.gasReimburseIn,
    gasReimburseOut: event.params.gasReimburseOut,
    gasRecipient: event.params.gasRecipient,
    makerDigest: digests?.makerDigest,
    takerDigest: digests?.takerDigest,
    digestAssociated: digests !== null,
  })
  context.TxCursor.set({ ...cursor, tradeIds: [...cursor.tradeIds, id] })
}

async function handleGasShare(event: GasEvent, context: Ctx) {
  const txHash = event.transaction.hash
  const id = gasShareEntityId(event.chainId, txHash, event.logIndex)
  const cursor = await context.TxCursor.get(txHash)
  // 第 N 个 GasCostShared ↔ 第 N 笔成交；再以 maker/taker 双核对防错位
  let tradeId: string | undefined
  if (cursor && cursor.gasCount < cursor.tradeIds.length) {
    const candidateId = cursor.tradeIds[cursor.gasCount]
    const trade = await context.Trade.get(candidateId)
    if (
      trade &&
      trade.maker.toLowerCase() === event.params.maker.toLowerCase() &&
      trade.taker.toLowerCase() === event.params.taker.toLowerCase()
    ) {
      tradeId = candidateId
    }
  }
  context.GasShare.set({
    id,
    contractAddress: event.srcAddress,
    txHash,
    logIndex: event.logIndex,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    trade_id: tradeId,
    maker: event.params.maker,
    taker: event.params.taker,
    gasRecipient: event.params.gasRecipient,
    gasUsed: event.params.gasUsed,
    gasCostWei: event.params.gasCostWei,
    reason: Number(event.params.reason),
    makerToken: event.params.makerToken,
    makerDeduct: event.params.makerDeduct,
    makerShortfall: event.params.makerShortfall,
    takerToken: event.params.takerToken,
    takerDeduct: event.params.takerDeduct,
    takerShortfall: event.params.takerShortfall,
  })
  if (cursor) {
    context.TxCursor.set({ ...cursor, gasCount: cursor.gasCount + 1 })
  }
}

indexer.onEvent(
  { contract: 'Settlement', event: 'TradeSettled', fields: TRADE_FIELDS },
  async ({ event, context }) => {
    await handleTrade(event as TradeEvent, context as Ctx, 'TradeSettled')
  },
)

indexer.onEvent(
  { contract: 'Settlement', event: 'TradeSettledWithGasReimburse', fields: TRADE_FIELDS },
  async ({ event, context }) => {
    await handleTrade(event as TradeEvent, context as Ctx, 'TradeSettledWithGasReimburse')
  },
)

indexer.onEvent(
  { contract: 'Settlement', event: 'GasCostShared', fields: GAS_FIELDS },
  async ({ event, context }) => {
    await handleGasShare(event as GasEvent, context as Ctx)
  },
)
