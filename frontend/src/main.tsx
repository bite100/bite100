import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { getEthereumAsync } from './utils'
import './index.css'

const DETECT_TIMEOUT_MS = 5000

/** 钱包内打开时 provider 可能延迟注入，等待后再加载 Wagmi/App；检测到的 provider 写入 window.ethereum 供 Wagmi injected() 使用 */
function WaitForWallet() {
  const [Content, setContent] = useState<React.ComponentType | null>(null)
  const [gaveUp, setGaveUp] = useState(false)

  useEffect(() => {
    let cancelled = false
    getEthereumAsync(DETECT_TIMEOUT_MS).then(async (early) => {
      if (cancelled) return
      // 再等一小段，应对极晚注入
      const provider = early ?? await getEthereumAsync(800)
      if (cancelled) return
      if (provider) {
        try {
          (window as unknown as { ethereum: unknown }).ethereum = provider
        } catch (_) {}
      }
      if (cancelled) return
      if (!provider) setGaveUp(true)
      const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
      const { WagmiProvider } = await import('wagmi')
      const { RainbowKitProvider } = await import('@rainbow-me/rainbowkit')
      const { wagmiConfig } = await import('./walletConfig')
      const App = (await import('./App')).default
      const { ServiceWorkerUpdate } = await import('./components/ServiceWorkerUpdate')
      const queryClient = new QueryClient()
      if (cancelled) return
      setContent(() => function AppWithProviders() {
        return (
          <WagmiProvider config={wagmiConfig}>
            <QueryClientProvider client={queryClient}>
              <RainbowKitProvider appInfo={{ appName: '比特100' }}>
                <ServiceWorkerUpdate />
                <App />
              </RainbowKitProvider>
            </QueryClientProvider>
          </WagmiProvider>
        )
      })
    })
    return () => { cancelled = true }
  }, [])

  if (!Content) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: '#666', fontSize: '0.95rem', gap: 12, padding: 24 }}>
        <span>{gaveUp ? '未检测到钱包' : '正在检测钱包环境…'}</span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{ padding: '8px 16px', fontSize: '0.9rem', cursor: 'pointer' }}
        >
          {gaveUp ? '点击刷新重试' : '刷新页面'}
        </button>
        <span style={{ fontSize: '0.8rem', color: '#999' }}>若在钱包 App 内打开，请稍候几秒或点击刷新</span>
      </div>
    )
  }
  return <Content />
}

// 确保 RainbowKit 样式在首屏后加载
import('@rainbow-me/rainbowkit/styles.css')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WaitForWallet />
  </React.StrictMode>,
)
