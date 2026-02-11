/**
 * 发币平台连接方式：用户点击 → 同步 provider → eth_requestAccounts（EIP-1102）→ 再同步 Wagmi 状态
 */
import { useState } from 'react'
import { useConnect } from 'wagmi'
import { connectors } from '../walletConfig'
import { hasInjectedProvider, requestAccountsOnUserGesture } from '../services/standardConnect'

const injectedConnector = () => connectors.find((c) => (c as { type?: string }).type === 'injected') ?? connectors[connectors.length - 1]
const wcConnector = () => connectors.find((c) => (c as { type?: string }).type === 'walletConnect')

export function StandardConnect() {
  const { connect, isPending, error } = useConnect()
  const [injectedError, setInjectedError] = useState<string | null>(null)

  const handleInjected = async () => {
    setInjectedError(null)
    try {
      await requestAccountsOnUserGesture()
      const c = injectedConnector()
      if (c) connect({ connector: c })
    } catch (e) {
      const msg = (e as { message?: string; code?: number }).message ?? String(e)
      if ((e as { code?: number }).code !== 4001) setInjectedError(msg)
    }
  }

  const handleWalletConnect = () => {
    const c = wcConnector()
    if (c) connect({ connector: c })
  }

  const hasInjected = hasInjectedProvider()
  const hasWC = !!wcConnector()

  return (
    <div className="connect-buttons" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '0.5rem' }}>
      {hasInjected && (
        <button type="button" className="btn" onClick={handleInjected} disabled={isPending}>
          {isPending ? '连接中…' : '连接浏览器钱包'}
        </button>
      )}
      {hasWC && (
        <button type="button" className="btn secondary" onClick={handleWalletConnect} disabled={isPending}>
          {isPending ? '连接中…' : 'WalletConnect 扫码'}
        </button>
      )}
      {!hasInjected && !hasWC && (
        <span style={{ fontSize: '0.9rem', color: '#888' }}>请安装 MetaMask、Phantom 等扩展，或配置 WalletConnect</span>
      )}
      {(error?.message || injectedError) && (
        <span style={{ fontSize: '0.85rem', color: '#c00' }}>{error?.message ?? injectedError}</span>
      )}
    </div>
  )
}
