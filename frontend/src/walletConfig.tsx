/**
 * Wagmi 配置：多链 + 注入钱包（MetaMask 等）
 * 与 frontend/src/config/chains.ts 对齐
 * 清单 3.1：RPC 轮询/fallback，主 RPC 失败时自动切换
 *
 * 移动端：Trust 注入在 window.trustwallet，Phantom 在 window.phantom.ethereum；
 * index.html 会尽早同步到 window.ethereum，此处再同步一次应对缓存旧 HTML。
 */
import { createConfig } from 'wagmi'
import { fallback, http } from 'viem'
import { arbitrum, base, bsc, mainnet, optimism, polygon, sepolia } from 'wagmi/chains'
import { injected, walletConnect } from '@wagmi/connectors'

function syncMobileProvider(): void {
  if (typeof window === 'undefined') return
  const w = window as unknown as { ethereum?: unknown; trustwallet?: unknown; phantom?: { ethereum?: unknown } }
  if (w.ethereum) return
  try {
    if (w.trustwallet) w.ethereum = w.trustwallet
    else if (w.phantom?.ethereum) w.ethereum = w.phantom.ethereum
  } catch (_) {}
}
syncMobileProvider()

// 每链主 RPC + 备用 RPC（fallback 时自动切换）
const RPC_URLS: Record<number, string[]> = {
  [sepolia.id]: ['https://ethereum-sepolia.publicnode.com', 'https://rpc.sepolia.org'],
  [mainnet.id]: ['https://ethereum.publicnode.com', 'https://eth.llamarpc.com'],
  [polygon.id]: ['https://polygon-rpc.com', 'https://polygon-bor-rpc.publicnode.com'],
  [arbitrum.id]: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum.llamarpc.com'],
  [base.id]: ['https://mainnet.base.org', 'https://base.llamarpc.com'],
  [optimism.id]: ['https://mainnet.optimism.io', 'https://optimism.llamarpc.com'],
  [bsc.id]: ['https://bsc-dataseed.binance.org', 'https://bsc-dataseed1.defibit.io'],
}

function transport(chainId: number) {
  const urls = RPC_URLS[chainId]
  if (!urls || urls.length === 0) return http()
  if (urls.length === 1) return http(urls[0])
  return fallback(urls.map((url) => http(url)))
}

const wcProjectId = import.meta.env.VITE_WC_PROJECT_ID

// 移动端优先 WalletConnect（业内做法）；Trust 等内置浏览器由 index.html 将 trustwallet 同步到 ethereum
const connectors = [
  ...(wcProjectId
    ? [
        walletConnect({
          projectId: wcProjectId,
          showQrModal: true,
        }),
      ]
    : []),
  injected(),
]

export const wagmiConfig = createConfig({
  chains: [sepolia, mainnet, polygon, arbitrum, base, optimism, bsc],
  connectors,
  transports: {
    [sepolia.id]: transport(sepolia.id),
    [mainnet.id]: transport(mainnet.id),
    [polygon.id]: transport(polygon.id),
    [arbitrum.id]: transport(arbitrum.id),
    [base.id]: transport(base.id),
    [optimism.id]: transport(optimism.id),
    [bsc.id]: transport(bsc.id),
  },
})
