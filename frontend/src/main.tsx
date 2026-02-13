import React from 'react'
import ReactDOM from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider } from 'wagmi'
import { RainbowKitProvider } from '@rainbow-me/rainbowkit'
import '@rainbow-me/rainbowkit/styles.css'
import '@mantine/core/styles.css'
import App from './App'
import { ServiceWorkerUpdate } from './components/ServiceWorkerUpdate'
import { wagmiConfig } from './walletConfig'
import { theme } from './theme'
import './index.css'

const queryClient = new QueryClient()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <RainbowKitProvider appInfo={{ appName: '比特100' }}>
            <ServiceWorkerUpdate />
            <App />
          </RainbowKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </MantineProvider>
  </React.StrictMode>,
)
