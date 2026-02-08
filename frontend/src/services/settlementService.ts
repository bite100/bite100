import { ethers } from 'ethers'
import { SETTLEMENT_ADDRESS, SETTLEMENT_ABI, TOKEN0_ADDRESS, TOKEN1_ADDRESS } from '../config'
import { MatchStorage } from '../p2p/storage'
import type { Trade } from '../p2p/types'

const DECIMALS = 18

/**
 * 链下撮合后链上结算
 * 调用 Settlement.settleTrade(maker, taker, tokenIn, tokenOut, amountIn, amountOut, 0, 0)
 * 注意：合约仅允许 owner 或 relayer 调用，普通用户会 revert；此时仍会广播 Match，待 relayer/链上确认后由 chainSync 同步 txHash
 */
export async function settleTrade(
  signer: ethers.Signer,
  trade: Trade
): Promise<{ txHash: string } | { error: string }> {
  const tokenIn = trade.makerSide === 'sell' ? TOKEN0_ADDRESS : TOKEN1_ADDRESS
  const tokenOut = trade.makerSide === 'sell' ? TOKEN1_ADDRESS : TOKEN0_ADDRESS
  const amountIn = ethers.parseUnits(trade.amount, DECIMALS)
  const amountOut = ethers.parseUnits(
    (parseFloat(trade.amount) * parseFloat(trade.price)).toFixed(DECIMALS),
    DECIMALS
  )
  const contract = new ethers.Contract(SETTLEMENT_ADDRESS, SETTLEMENT_ABI, signer)
  try {
    const tx = await contract.settleTrade(
      trade.maker,
      trade.taker,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
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
