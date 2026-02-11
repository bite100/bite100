import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { getEthereumAsync } from './utils'
import './index.css'

/** 钱包内打开时 provider 可能延迟注入，等待后再加载 Wagmi/App，便于检测到钱包 */
function WaitForWallet() {
  const [Content, setContent] = useState<React.ComponentType | null>(null)

  useEffect(() => {
    getEthereumAsync(2500).finally(async () => {
      const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
      const { WagmiProvider } = await import('wagmi')
      const { RainbowKitProvider } = await import('@rainbow-me/rainbowkit')
      const { wagmiConfig } = await import('./walletConfig')
      const App = (await import('./App')).default
      const { ServiceWorkerUpdate } = await import('./components/ServiceWorkerUpdate')
      const queryClient = new QueryClient()
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
  }, [])

  if (!Content) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: '#666', fontSize: '0.95rem' }}>
        正在检测钱包环境…
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
