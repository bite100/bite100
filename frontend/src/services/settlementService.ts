import { ethers } from 'ethers'
import { SETTLEMENT_ADDRESS, SETTLEMENT_ABI, TOKEN0_ADDRESS, TOKEN1_ADDRESS } from '../config'
import { MatchStorage } from '../p2p/storage'
import type { Trade } from '../p2p/types'

const DECIMALS = 18

function tradeToSettleParams(trade: Trade) {
  const tokenIn = trade.makerSide === 'sell' ? TOKEN0_ADDRESS : TOKEN1_ADDRESS
  const tokenOut = trade.makerSide === 'sell' ? TOKEN1_ADDRESS : TOKEN0_ADDRESS
  const amountIn = ethers.parseUnits(trade.amount, DECIMALS)
  const amountOut = ethers.parseUnits(
    (parseFloat(trade.amount) * parseFloat(trade.price)).toFixed(DECIMALS),
    DECIMALS
  )
  return { maker: trade.maker, taker: trade.taker, tokenIn, tokenOut, amountIn, amountOut }
}

/**
 * 链下撮合后链上结算
 * 调用 Settlement.settleTrade(maker, taker, tokenIn, tokenOut, amountIn, amountOut, 0, 0)
 * 注意：合约仅允许 owner 或 relayer 调用，普通用户会 revert；此时仍会广播 Match，待 relayer/链上确认后由 chainSync 同步 txHash
 */
export async function settleTrade(
  signer: ethers.Signer,
  trade: Trade
): Promise<{ txHash: string } | { error: string }> {
  const p = tradeToSettleParams(trade)
  const contract = new ethers.Contract(SETTLEMENT_ADDRESS, SETTLEMENT_ABI, signer)
  try {
    const tx = await contract.settleTrade(
      p.maker,
      p.taker,
      p.tokenIn,
      p.tokenOut,
      p.amountIn,
      p.amountOut,
      0,
      0
    )
    const receipt = await tx.wait()
    const txHash = receipt?.hash ?? tx.hash
    await MatchStorage.updateMatchTxHash(trade.tradeId, txHash)
    window.dispatchEvent(
      new CustomEvent('trade-settled', { detail: { trade, txHash } })
    )
    return { txHash }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('settleTrade 失败（可能非 owner/relayer）:', message)
    return { error: message }
  }
}

/**
 * §12.3 Epoch 批量结算：多笔成交一次上链，降低 gas
 * 调用 Settlement.settleTradesBatch；需 owner/relayer；1–50 笔
 */
export async function settleTradesBatch(
  signer: ethers.Signer,
  trades: Trade[]
): Promise<{ txHash: string } | { error: string }> {
  if (trades.length === 0 || trades.length > 50) {
    return { error: 'batch size 1-50' }
  }
  const makers: string[] = []
  const takers: string[] = []
  const tokenIns: string[] = []
  const tokenOuts: string[] = []
  const amountIns: bigint[] = []
  const amountOuts: bigint[] = []
  const zeros: bigint[] = []
  for (const t of trades) {
    const p = tradeToSettleParams(t)
    makers.push(p.maker)
    takers.push(p.taker)
    tokenIns.push(p.tokenIn)
    tokenOuts.push(p.tokenOut)
    amountIns.push(p.amountIn)
    amountOuts.push(p.amountOut)
    zeros.push(0n)
  }
  const contract = new ethers.Contract(SETTLEMENT_ADDRESS, SETTLEMENT_ABI, signer)
  try {
    const tx = await contract.settleTradesBatch(
      makers,
      takers,
      tokenIns,
      tokenOuts,
      amountIns,
      amountOuts,
      zeros,
      zeros
    )
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
