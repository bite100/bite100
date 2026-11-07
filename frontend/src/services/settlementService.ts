import { ethers } from 'ethers'
import { SETTLEMENT_ADDRESS, SETTLEMENT_ABI, TOKEN0_ADDRESS, TOKEN1_ADDRESS } from '../config'
import { MatchStorage, OrderStorage, type StoredOrder } from '../p2p/storage'
import type { Trade } from '../p2p/types'

const SCALE = 10n ** 18n

/** 与合约 Settlement.Order 对齐的订单结构（统一规范见 docs/eip712-order-spec.md） */
export interface ContractOrder {
  orderId: string
  userAddress: string
  tokenIn: string
  tokenOut: string
  amountIn: bigint
  amountOut: bigint
  price: bigint
  timestamp: bigint
  expiresAt: bigint
  nonce: bigint
}

/** 与合约 Settlement.Fill 对齐的结算请求 */
export interface ContractFill {
  makerOrder: { order: ContractOrder; signature: string }
  takerOrder: { order: ContractOrder; signature: string }
  tokenIn: string
  tokenOut: string
  amountIn: bigint
  amountOut: bigint
  gasReimburseIn: bigint
  gasReimburseOut: bigint
}

/** 把本地存储的签名订单转换为合约订单结构（amountOut 按统一公式 amountIn*price/1e18 派生，与签名时一致） */
function storedOrderToContractOrder(o: StoredOrder): ContractOrder {
  const amountIn = BigInt(o.amount)
  const price = BigInt(o.price)
  const amountOut = (amountIn * price) / SCALE
  const extra = o as unknown as Record<string, unknown>
  const timestamp = Number(o.timestamp ?? extra.createdAt ?? 0)
  const expiresAt = Number(o.expiresAt ?? (timestamp ? timestamp + 86400 : 0))
  return {
    orderId: o.orderId,
    userAddress: o.trader,
    tokenIn: TOKEN0_ADDRESS,
    tokenOut: TOKEN1_ADDRESS,
    amountIn,
    amountOut,
    price,
    timestamp: BigInt(timestamp),
    expiresAt: BigInt(expiresAt),
    nonce: BigInt(Number(extra.nonce ?? 0)),
  }
}

/**
 * 由一笔本地成交与双方存储订单构造链上 Fill。
 * 成交量以 Token0 计量（trade.amount，人类单位）与 maker 签名价格重算真实代币量，
 * 与节点 TradeToFill 同口径；找不到双方签名订单时抛错（无法验签结算）。
 */
export async function buildFill(trade: Trade): Promise<ContractFill> {
  const [makerStored, takerStored] = await Promise.all([
    OrderStorage.getOrder(trade.makerOrderId),
    OrderStorage.getOrder(trade.takerOrderId),
  ])
  if (!makerStored || !takerStored) {
    throw new Error('本地未找到双方签名订单，无法组装验签结算')
  }
  const makerOrder = storedOrderToContractOrder(makerStored)
  const takerOrder = storedOrderToContractOrder(takerStored)
  const qty0 = ethers.parseUnits(trade.amount, 18)
  const qty1 = (qty0 * makerOrder.price) / SCALE
  const makerSellsToken0 = trade.makerSide !== 'buy'
  return {
    makerOrder: { order: makerOrder, signature: makerStored.signature },
    takerOrder: { order: takerOrder, signature: takerStored.signature },
    tokenIn: makerSellsToken0 ? TOKEN0_ADDRESS : TOKEN1_ADDRESS,
    tokenOut: makerSellsToken0 ? TOKEN1_ADDRESS : TOKEN0_ADDRESS,
    amountIn: makerSellsToken0 ? qty0 : qty1,
    amountOut: makerSellsToken0 ? qty1 : qty0,
    gasReimburseIn: 0n,
    gasReimburseOut: 0n,
  }
}

/**
 * 链下撮合后链上验签结算：调用 Settlement.settleTrade(Fill)，合约校验双方订单签名、
 * 累计成交量与 nonce 后才划转（提交者只是搬运工，但仍需 owner/relayer 身份）。
 * 失败时仅保留「待结算」状态，待 relayer/链上确认后由 chainSync 同步 txHash。
 */
export async function settleTrade(
  signer: ethers.Signer,
  trade: Trade
): Promise<{ txHash: string } | { error: string }> {
  const contract = new ethers.Contract(SETTLEMENT_ADDRESS, SETTLEMENT_ABI, signer)
  try {
    const fill = await buildFill(trade)
    const tx = await contract.settleTrade(fill)
    const receipt = await tx.wait()
    const txHash = receipt?.hash ?? tx.hash
    await MatchStorage.updateMatchTxHash(trade.tradeId, txHash)
    window.dispatchEvent(
      new CustomEvent('trade-settled', { detail: { trade, txHash } })
    )
    return { txHash }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('settleTrade 失败（可能非 owner/relayer 或订单校验未通过）:', message)
    return { error: message }
  }
}

/**
 * §12.3 Epoch 批量结算：多笔成交一次上链（每笔 Fill 与单笔同样验签）；需 owner/relayer；1–50 笔
 */
export async function settleTradesBatch(
  signer: ethers.Signer,
  trades: Trade[]
): Promise<{ txHash: string } | { error: string }> {
  if (trades.length === 0 || trades.length > 50) {
    return { error: 'batch size 1-50' }
  }
  const contract = new ethers.Contract(SETTLEMENT_ADDRESS, SETTLEMENT_ABI, signer)
  try {
    const fills = await Promise.all(trades.map((t) => buildFill(t)))
    const tx = await contract.settleTradesBatch(fills)
    const receipt = await tx.wait()
    const txHash = receipt?.hash ?? tx.hash
    for (const trade of trades) {
      await MatchStorage.updateMatchTxHash(trade.tradeId, txHash)
      window.dispatchEvent(
        new CustomEvent('trade-settled', { detail: { trade, txHash } })
      )
    }
    return { txHash }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('settleTradesBatch 失败:', message)
    return { error: message }
  }
}
