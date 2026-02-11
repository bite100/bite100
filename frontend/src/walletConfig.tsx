/**
 * Wagmi 配置：多链 + 注入钱包（MetaMask 等）
 * 与 frontend/src/config/chains.ts 对齐
 * 清单 3.1：RPC 轮询/fallback，主 RPC 失败时自动切换
 */
import { createConfig } from 'wagmi'
import { fallback, http } from 'viem'
import { arbitrum, base, bsc, mainnet, optimism, polygon, sepolia } from 'wagmi/chains'
import { injected, walletConnect } from '@wagmi/connectors'

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

const connectors = [
  injected(),
  ...(wcProjectId
    ? [
        walletConnect({
          projectId: wcProjectId,
          showQrModal: true,
        }),
      ]
    : []),
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
