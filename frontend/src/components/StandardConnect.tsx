/**
 * 发币平台连接方式：手机浏览器点击 → deep link 打开钱包 App → 钱包内置浏览器打开页面 → 连接
 */
import { useState, useMemo } from 'react'
import { useConnect } from 'wagmi'
import { connectors } from '../walletConfig'
import { hasInjectedProvider, requestAccountsOnUserGesture } from '../services/standardConnect'
import { tryOpenAnyWalletApp } from '../services/walletDeepLink'

function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 0 && window.innerWidth < 768)
}

const injectedConnector = () => connectors.find((c) => (c as { type?: string }).type === 'injected') ?? connectors[connectors.length - 1]
const wcConnector = () => connectors.find((c) => (c as { type?: string }).type === 'walletConnect')

export function StandardConnect() {
  const { connect, isPending, error } = useConnect()
  const [injectedError, setInjectedError] = useState<string | null>(null)
  const mobile = useMemo(() => isMobile(), [])

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

  /** 手机浏览器：点击连接 → deep link 打开钱包 App → 钱包内置浏览器打开页面 */
  const handleMobileConnect = () => {
    if (tryOpenAnyWalletApp()) {
      // deep link 成功，用户会在钱包 App 内置浏览器里打开页面，那里会有注入的 provider
      return
    }
    // deep link 失败，fallback 到 WalletConnect
    handleWalletConnect()
  }

  const hasInjected = hasInjectedProvider()
  const hasWC = !!wcConnector()
  // 手机浏览器：即使没有注入，也显示连接按钮（deep link 或 WalletConnect）
  const showInjected = hasInjected
  const showWC = hasWC && (hasInjected || mobile)

  return (
    <div className="connect-buttons" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '0.5rem' }}>
      {showInjected && (
        <button type="button" className="btn" onClick={handleInjected} disabled={isPending}>
          {isPending ? '连接中…' : '连接浏览器钱包'}
        </button>
      )}
      {mobile && !hasInjected && (
        <button type="button" className="btn" onClick={handleMobileConnect} disabled={isPending}>
          {isPending ? '连接中…' : '连接钱包'}
        </button>
      )}
      {showWC && !mobile && (
        <button type="button" className="btn secondary" onClick={handleWalletConnect} disabled={isPending}>
          {isPending ? '连接中…' : 'WalletConnect 扫码连接'}
        </button>
      )}
      {!showInjected && !showWC && !mobile && (
        <span style={{ fontSize: '0.9rem', color: '#888' }}>请安装 MetaMask、Phantom 等扩展，或配置 WalletConnect</span>
      )}
      {(error?.message || injectedError) && (
        <span style={{ fontSize: '0.85rem', color: '#c00' }}>{error?.message ?? injectedError}</span>
      )}
    </div>
  )
}
