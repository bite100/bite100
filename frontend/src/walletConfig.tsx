/**
 * Wagmi 配置：多链 + 注入钱包（MetaMask 等）
 * 与 frontend/src/config/chains.ts 对齐
 *
 * 移动端：主流钱包注入在各自 key 下（trustwallet、phantom、okxwallet、bitget 等），
 * 需同步到 window.ethereum 供 EIP-1193/Wagmi 检测。
 */
import { createConfig } from 'wagmi'
import { fallback, http } from 'viem'
import { arbitrum, base, bsc, mainnet, optimism, polygon, sepolia } from 'wagmi/chains'
import { injected, walletConnect } from '@wagmi/connectors'

type Win = {
  ethereum?: unknown
  trustwallet?: unknown
  phantom?: { ethereum?: unknown }
  okxwallet?: unknown
  bitget?: unknown
  tokenpocket?: unknown
  imToken?: unknown
  onekey?: unknown
  safepal?: unknown
  rabby?: unknown
  coinbaseWallet?: unknown
}

/** 主流钱包注入 key 的检测顺序（先检测的优先同步到 ethereum） */
const MOBILE_PROVIDER_KEYS: (keyof Win)[] = [
  'trustwallet',
  'phantom', // 使用 w.phantom?.ethereum
  'okxwallet',
  'bitget',
  'tokenpocket',
  'imToken',
  'onekey',
  'safepal',
  'rabby',
  'coinbaseWallet',
]

/** 将主流钱包 provider 同步到 window.ethereum，供 EIP-1193 检测；连接前可再调一次应对延迟注入 */
export function syncMobileProvider(): void {
  if (typeof window === 'undefined') return
  const w = window as unknown as Win
  if (w.ethereum) return
  try {
    if (w.phantom?.ethereum) {
      w.ethereum = w.phantom.ethereum
      return
    }
    for (const k of MOBILE_PROVIDER_KEYS) {
      if (k === 'phantom') continue
      const v = w[k]
      if (v && typeof (v as { request?: unknown }).request === 'function') {
        w.ethereum = v
        return
      }
    }
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

// 移动端优先 WalletConnect；Trust 等内置浏览器由 index.html 同步到 ethereum
export const connectors = [
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
