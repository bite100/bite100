/**
 * 发币平台连接方式：手机浏览器点击「连接钱包」→ 弹出钱包列表 → 用户选择后再跳转对应 App
 * 优化：连接状态持久化、详细错误提示、连接超时处理、主流钱包可选
 */
import { useState, useMemo, useEffect } from 'react'
import { useConnect, useAccount } from 'wagmi'
import { connectors } from '../walletConfig'
import { hasInjectedProvider, requestAccountsOnUserGesture, saveConnectionState, clearConnectionState } from '../services/standardConnect'
import {
  tryOpenWalletApp,
  isInWalletBrowser,
  detectWalletFromUA,
  getDetectedWallets,
  addDetectedWallet,
  type WalletDeepLinkKey,
} from '../services/walletDeepLink'
import { formatError } from '../utils'

function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 0 && window.innerWidth < 768)
}

const injectedConnector = () => connectors.find((c) => (c as { type?: string }).type === 'injected') ?? connectors[connectors.length - 1]
const wcConnector = () => connectors.find((c) => (c as { type?: string }).type === 'walletConnect')

const MOBILE_WALLET_OPTIONS: { key: WalletDeepLinkKey; label: string }[] = [
  { key: 'metamask', label: 'MetaMask' },
  { key: 'trust', label: 'Trust' },
  { key: 'okx', label: 'OKX' },
  { key: 'tokenpocket', label: 'TokenPocket' },
  { key: 'bitget', label: 'Bitget' },
  { key: 'imtoken', label: 'imToken' },
  { key: 'phantom', label: 'Phantom' },
  { key: 'coinbase', label: 'Coinbase' },
  { key: 'onekey', label: 'OneKey' },
  { key: 'safepal', label: 'SafePal' },
  { key: 'rabby', label: 'Rabby' },
  { key: 'foxwallet', label: 'FoxWallet' },
  { key: 'zerion', label: 'Zerion' },
  { key: 'uniswap', label: 'Uniswap Wallet' },
  { key: 'mathwallet', label: 'MathWallet' },
  { key: 'coin98', label: 'Coin98' },
  { key: 'cryptocom', label: 'Crypto.com' },
  { key: 'argent', label: 'Argent' },
  { key: 'ledger', label: 'Ledger' },
  { key: 'backpack', label: 'Backpack' },
  { key: 'solflare', label: 'Solflare' },
  { key: 'xdefi', label: 'XDEFI' },
  { key: 'taho', label: 'Taho' },
  { key: 'safe', label: 'Safe' },
  { key: 'bybit', label: 'Bybit' },
  { key: 'gate', label: 'Gate.io' },
  { key: 'htx', label: 'HTX' },
  { key: 'zengo', label: 'Zengo' },
  { key: 'ronin', label: 'Ronin' },
  { key: 'core', label: 'Core' },
  { key: 'brave', label: 'Brave' },
  { key: 'frame', label: 'Frame' },
  { key: 'frontier', label: 'Frontier' },
  { key: 'ambire', label: 'Ambire' },
  { key: 'exodus', label: 'Exodus' },
  { key: 'liquality', label: 'Liquality' },
  { key: 'rainbow', label: 'Rainbow' },
]

export function StandardConnect() {
  const { connect, isPending, error } = useConnect()
  const { address, isConnected } = useAccount()
  const [injectedError, setInjectedError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [mobilePickerOpen, setMobilePickerOpen] = useState(false)
  const [showAllWallets, setShowAllWallets] = useState(false)
  const mobile = useMemo(() => isMobile(), [])
  const detectedWallets = useMemo(() => getDetectedWallets(), [mobilePickerOpen])
  const walletOptionsToShow = useMemo((): { key: WalletDeepLinkKey; label: string }[] => {
    const labelMap = new Map(MOBILE_WALLET_OPTIONS.map((o) => [o.key, o.label]))
    if (showAllWallets) return MOBILE_WALLET_OPTIONS
    if (detectedWallets.length > 0) {
      return detectedWallets
        .map((key) => ({ key, label: labelMap.get(key) ?? key }))
        .filter((o): o is { key: WalletDeepLinkKey; label: string } => Boolean(o.label))
    }
    return MOBILE_WALLET_OPTIONS
  }, [detectedWallets, showAllWallets])

  // 连接成功后保存状态
  useEffect(() => {
    if (isConnected && address) {
      saveConnectionState('injected', address)
    } else if (!isConnected) {
      clearConnectionState()
    }
  }, [isConnected, address])

  // 当前在钱包内置浏览器中时，记入「已安装的钱包」列表，下次在手机浏览器里只展示这些
  useEffect(() => {
    if (isInWalletBrowser()) {
      const w = detectWalletFromUA()
      if (w) addDetectedWallet(w)
    }
  }, [])

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

  /** 手机端：用户从列表中选择某一钱包后，打开该钱包 deep link */
  const handleMobilePickWallet = (walletKey: WalletDeepLinkKey) => {
    setInjectedError(null)
    const opened = tryOpenWalletApp(walletKey)
    if (!opened && hasWC) {
      handleWalletConnect()
    }
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
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '0.5rem', width: '100%' }}>
          <button
            type="button"
            className="btn"
            style={{ alignSelf: 'flex-start' }}
            disabled={isConnecting}
            onClick={() => {
              setMobilePickerOpen((o) => !o)
              if (mobilePickerOpen) setShowAllWallets(false)
            }}
          >
            {isConnecting ? '连接中…' : mobilePickerOpen ? '收起钱包列表' : '连接钱包'}
          </button>
          {mobilePickerOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '0.4rem', width: '100%', padding: '0.5rem 0', borderTop: '1px solid #333' }}>
              <div style={{ fontSize: '0.85rem', color: '#a1a1aa', marginBottom: '0.25rem' }}>
                {detectedWallets.length > 0 && !showAllWallets
                  ? '选择已安装的钱包（点击后跳转至该 App 打开本页）'
                  : '选择要使用的钱包（点击后跳转至该 App 打开本页）'}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                {walletOptionsToShow.map((w) => (
                  <button
                    key={w.key}
                    type="button"
                    className="btn secondary"
                    style={{ padding: '0.35rem 0.65rem', fontSize: '0.8rem' }}
                    disabled={isConnecting}
                    onClick={() => handleMobilePickWallet(w.key)}
                  >
                    {w.label}
                  </button>
                ))}
              </div>
              {detectedWallets.length > 0 && !showAllWallets && (
                <button
                  type="button"
                  className="btn secondary"
                  style={{ marginTop: '0.15rem', padding: '0.3rem 0.5rem', fontSize: '0.75rem' }}
                  onClick={() => setShowAllWallets(true)}
                >
                  未列出？显示更多钱包
                </button>
              )}
              {showAllWallets && (
                <button
                  type="button"
                  className="btn secondary"
                  style={{ marginTop: '0.15rem', padding: '0.3rem 0.5rem', fontSize: '0.75rem' }}
                  onClick={() => setShowAllWallets(false)}
                >
                  仅显示已安装
                </button>
              )}
              {hasWC && (
                <button
                  type="button"
                  className="btn secondary"
                  style={{ marginTop: '0.25rem', padding: '0.35rem 0.65rem', fontSize: '0.8rem' }}
                  disabled={isConnecting}
                  onClick={handleWalletConnect}
                >
                  {isConnecting ? '连接中…' : 'WalletConnect 扫码连接'}
                </button>
              )}
            </div>
          )}
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
