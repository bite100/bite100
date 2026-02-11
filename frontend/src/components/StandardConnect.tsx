/**
 * 发币平台连接方式：手机浏览器点击 → deep link 打开钱包 App → 钱包内置浏览器打开页面 → 连接
 * 优化：连接状态持久化、详细错误提示、连接超时处理、主流钱包可选
 */
import { useState, useMemo, useEffect } from 'react'
import { useConnect, useAccount } from 'wagmi'
import { connectors } from '../walletConfig'
import { hasInjectedProvider, requestAccountsOnUserGesture, saveConnectionState, clearConnectionState } from '../services/standardConnect'
import { tryOpenAnyWalletApp, tryOpenWalletApp, type WalletDeepLinkKey } from '../services/walletDeepLink'
import { formatError } from '../utils'

function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 0 && window.innerWidth < 768)
}

const injectedConnector = () => connectors.find((c) => (c as { type?: string }).type === 'injected') ?? connectors[connectors.length - 1]
const wcConnector = () => connectors.find((c) => (c as { type?: string }).type === 'walletConnect')

export function StandardConnect() {
  const { connect, isPending, error } = useConnect()
  const { address, isConnected } = useAccount()
  const [injectedError, setInjectedError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const mobile = useMemo(() => isMobile(), [])

  // 连接成功后保存状态
  useEffect(() => {
    if (isConnected && address) {
      saveConnectionState('injected', address)
    } else if (!isConnected) {
      clearConnectionState()
    }
  }, [isConnected, address])

  const handleInjected = async () => {
    setInjectedError(null)
    setConnecting(true)
    try {
      await requestAccountsOnUserGesture()
      const c = injectedConnector()
      if (c) {
        connect({ connector: c })
      } else {
        throw new Error('未找到注入钱包连接器')
      }
    } catch (e) {
      const err = e as { message?: string; code?: number }
      // 用户拒绝（4001）不显示错误
      if (err.code !== 4001) {
        const errorMsg = formatError(e)
        setInjectedError(errorMsg || '连接失败，请重试')
      }
    } finally {
      setConnecting(false)
    }
  }

  const handleWalletConnect = () => {
    setInjectedError(null)
    const c = wcConnector()
    if (c) {
      connect({ connector: c })
    } else {
      setInjectedError('WalletConnect 未配置，请在环境变量中设置 VITE_WC_PROJECT_ID')
    }
  }

  /** 手机浏览器：点击连接 → deep link 打开钱包 App → 钱包内置浏览器打开页面 */
  const handleMobileConnect = () => {
    setInjectedError(null)
    if (tryOpenAnyWalletApp()) {
      // deep link 成功，用户会在钱包 App 内置浏览器里打开页面，那里会有注入的 provider
      // 提示用户等待页面在钱包中打开
      setInjectedError(null)
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
  const isConnecting = isPending || connecting

  // 获取错误消息（优先显示详细错误）
  const errorMessage = injectedError || error?.message || null

  return (
    <div className="connect-buttons" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '0.5rem' }}>
      {showInjected && (
        <button type="button" className="btn" onClick={handleInjected} disabled={isConnecting}>
          {isConnecting ? '连接中…' : '连接浏览器钱包'}
        </button>
      )}
      {mobile && !hasInjected && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '0.4rem' }}>
          <div style={{ fontSize: '0.9rem', color: '#ccc' }}>选择钱包：</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
            {[
              { key: 'metamask', label: 'MetaMask' },
              { key: 'trust', label: 'Trust' },
              { key: 'okx', label: 'OKX' },
              { key: 'tokenpocket', label: 'TokenPocket' },
              { key: 'bitget', label: 'Bitget' },
              { key: 'imtoken', label: 'imToken' },
            ].map((w) => (
              <button
                key={w.key}
                type="button"
                className="btn secondary"
                style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}
                disabled={isConnecting}
                onClick={() => {
                  setInjectedError(null)
                  if (!tryOpenWalletApp(w.key as WalletDeepLinkKey)) {
                    // 若特定钱包 deep link 失败，fallback 到自动选择
                    tryOpenAnyWalletApp() || handleWalletConnect()
                  }
                }}
              >
                {w.label}
              </button>
            ))}
            <button
              type="button"
              className="btn"
              style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}
              disabled={isConnecting}
              onClick={handleMobileConnect}
            >
              {isConnecting ? '连接中…' : '其他钱包'}
            </button>
          </div>
        </div>
      )}
      {showWC && !mobile && (
        <button type="button" className="btn secondary" onClick={handleWalletConnect} disabled={isConnecting}>
          {isConnecting ? '连接中…' : 'WalletConnect 扫码连接'}
        </button>
      )}
      {!showInjected && !showWC && !mobile && (
        <span style={{ fontSize: '0.9rem', color: '#888' }}>
          请安装 MetaMask、Phantom 等扩展，或配置 WalletConnect
        </span>
      )}
      {errorMessage && (
        <div style={{ fontSize: '0.85rem', color: '#c00', maxWidth: '100%', wordBreak: 'break-word' }}>
          {errorMessage}
        </div>
      )}
    </div>
  )
}
