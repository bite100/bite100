import { useEffect, useRef } from 'react'
import type { Signer } from 'ethers'
import { settleTrade } from '../services/settlementService'
import type { Trade } from '../p2p/types'

/**
 * 监听本地撮合结果，尝试链上 settleTrade（需 signer；合约通常仅 owner/relayer 可调用，失败时仅保留「待结算」状态）
 */
export function useSettleOnMatch(signer: Signer | null, account: string | null) {
  const settling = useRef(false)

  useEffect(() => {
    if (!signer || !account) return

    const handler = async (evt: Event) => {
      const trade = (evt as CustomEvent<Trade>).detail
      if (!trade || settling.current) return
      settling.current = true
      try {
        const result = await settleTrade(signer, trade)
        if ('txHash' in result) {
          console.log('✅ 链上结算成功:', result.txHash)
        } else {
          console.warn('⏳ 链上结算未执行:', result.error)
        }
      } finally {
        settling.current = false
      }
    }

    window.addEventListener('match-for-settlement', handler)
    return () => window.removeEventListener('match-for-settlement', handler)
  }, [signer, account])
}
