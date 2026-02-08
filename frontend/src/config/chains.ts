/**
 * 多链配置
 * 支持 Ethereum、Base、Arbitrum、Polygon、Optimism 等链
 */

export interface ChainConfig {
  chainId: number
  name: string
  rpcUrl: string
  blockExplorer?: string
  nativeCurrency: {
    name: string
    symbol: string
    decimals: number
  }
  contracts: {
    vault: string
    settlement: string
    token0: string
    token1: string
    ammPool: string
    contributorReward: string
    governance: string
    tokenRegistry: string
    chainConfig: string
  }
}

// Sepolia 测试网（已部署）
const SEPOLIA: ChainConfig = {
  chainId: 11155111,
  name: 'Sepolia',
  rpcUrl: 'https://ethereum-sepolia.publicnode.com',
  blockExplorer: 'https://sepolia.etherscan.io',
  nativeCurrency: {
    name: 'ETH',
    symbol: 'ETH',
    decimals: 18,
  },
  contracts: {
    vault: '0xbe3962Eaf7103d05665279469FFE3573352ec70C',
    settlement: '0x493Da680973F6c222c89eeC02922E91F1D9404a0',
    token0: '0x678195277dc8F84F787A4694DF42F3489eA757bf',
    token1: '0x9Be241a0bF1C2827194333B57278d1676494333a',
    ammPool: '0x8d392e6b270238c3a05dDB719795eE31ad7c72AF',
    contributorReward: '0x851019107c4F3150D90f1629f6A646eBC1B1E286',
    governance: '0x8F107ffaB0FC42E623AA69Bd10d8ad4cfbcE87BB',
    tokenRegistry: '0x77AF51BC13eE8b83274255f4a9077D3E9498c556',
    chainConfig: '0x7639fc976361752c8d9cb82a41bc5D0F423D5169',
  },
}

// Ethereum 主网（待部署）
const MAINNET: ChainConfig = {
  chainId: 1,
  name: 'Ethereum',
  rpcUrl: 'https://ethereum.publicnode.com',
  blockExplorer: 'https://etherscan.io',
  nativeCurrency: {
    name: 'ETH',
    symbol: 'ETH',
    decimals: 18,
  },
  contracts: {
    vault: '0x0000000000000000000000000000000000000000',
    settlement: '0x0000000000000000000000000000000000000000',
    token0: '0x0000000000000000000000000000000000000000',
    token1: '0x0000000000000000000000000000000000000000',
    ammPool: '0x0000000000000000000000000000000000000000',
    contributorReward: '0x0000000000000000000000000000000000000000',
    governance: '0x0000000000000000000000000000000000000000',
    tokenRegistry: '0x0000000000000000000000000000000000000000',
    chainConfig: '0x0000000000000000000000000000000000000000',
  },
}

// Base 主网（待部署）
const BASE: ChainConfig = {
  chainId: 8453,
  name: 'Base',
  rpcUrl: 'https://mainnet.base.org',
  blockExplorer: 'https://basescan.org',
  nativeCurrency: {
    name: 'ETH',
    symbol: 'ETH',
    decimals: 18,
  },
  contracts: {
    vault: '0x0000000000000000000000000000000000000000',
    settlement: '0x0000000000000000000000000000000000000000',
    token0: '0x0000000000000000000000000000000000000000', // USDC
    token1: '0x0000000000000000000000000000000000000000', // USDT
    ammPool: '0x0000000000000000000000000000000000000000',
    contributorReward: '0x0000000000000000000000000000000000000000',
    governance: '0x0000000000000000000000000000000000000000',
    tokenRegistry: '0x0000000000000000000000000000000000000000',
    chainConfig: '0x0000000000000000000000000000000000000000',
  },
}

// Arbitrum 主网（待部署）
const ARBITRUM: ChainConfig = {
  chainId: 42161,
  name: 'Arbitrum',
  rpcUrl: 'https://arb1.arbitrum.io/rpc',
  blockExplorer: 'https://arbiscan.io',
  nativeCurrency: {
    name: 'ETH',
    symbol: 'ETH',
    decimals: 18,
  },
  contracts: {
    vault: '0x0000000000000000000000000000000000000000',
    settlement: '0x0000000000000000000000000000000000000000',
    token0: '0x0000000000000000000000000000000000000000', // USDC
    token1: '0x0000000000000000000000000000000000000000', // USDT
    ammPool: '0x0000000000000000000000000000000000000000',
    contributorReward: '0x0000000000000000000000000000000000000000',
    governance: '0x0000000000000000000000000000000000000000',
    tokenRegistry: '0x0000000000000000000000000000000000000000',
    chainConfig: '0x0000000000000000000000000000000000000000',
  },
}

// Polygon 主网（待部署）
const POLYGON: ChainConfig = {
  chainId: 137,
  name: 'Polygon',
  rpcUrl: 'https://polygon-rpc.com',
  blockExplorer: 'https://polygonscan.com',
  nativeCurrency: {
    name: 'MATIC',
    symbol: 'MATIC',
    decimals: 18,
  },
  contracts: {
    vault: '0x0000000000000000000000000000000000000000',
    settlement: '0x0000000000000000000000000000000000000000',
    token0: '0x0000000000000000000000000000000000000000', // USDC
    token1: '0x0000000000000000000000000000000000000000', // USDT
    ammPool: '0x0000000000000000000000000000000000000000',
    contributorReward: '0x0000000000000000000000000000000000000000',
    governance: '0x0000000000000000000000000000000000000000',
    tokenRegistry: '0x0000000000000000000000000000000000000000',
    chainConfig: '0x0000000000000000000000000000000000000000',
  },
}

// Optimism 主网（待部署）
const OPTIMISM: ChainConfig = {
  chainId: 10,
  name: 'Optimism',
  rpcUrl: 'https://mainnet.optimism.io',
  blockExplorer: 'https://optimistic.etherscan.io',
  nativeCurrency: {
    name: 'ETH',
    symbol: 'ETH',
    decimals: 18,
  },
  contracts: {
    vault: '0x0000000000000000000000000000000000000000',
    settlement: '0x0000000000000000000000000000000000000000',
    token0: '0x0000000000000000000000000000000000000000', // USDC
    token1: '0x0000000000000000000000000000000000000000', // USDT
    ammPool: '0x0000000000000000000000000000000000000000',
    contributorReward: '0x0000000000000000000000000000000000000000',
    governance: '0x0000000000000000000000000000000000000000',
    tokenRegistry: '0x0000000000000000000000000000000000000000',
    chainConfig: '0x0000000000000000000000000000000000000000',
  },
}

// 所有链配置
export const CHAIN_CONFIGS: Record<number, ChainConfig> = {
  [SEPOLIA.chainId]: SEPOLIA,
  [MAINNET.chainId]: MAINNET,
  [BASE.chainId]: BASE,
  [ARBITRUM.chainId]: ARBITRUM,
  [POLYGON.chainId]: POLYGON,
  [OPTIMISM.chainId]: OPTIMISM,
}

// 支持的链列表
export const SUPPORTED_CHAINS = Object.values(CHAIN_CONFIGS)

// 默认链（Sepolia 测试网）
export const DEFAULT_CHAIN_ID = SEPOLIA.chainId

// 根据 chainId 获取链配置
export function getChainConfig(chainId: number): ChainConfig | null {
  return CHAIN_CONFIGS[chainId] || null
}

// 检查链是否支持
export function isChainSupported(chainId: number): boolean {
  return chainId in CHAIN_CONFIGS
}

// 获取链的 MetaMask 添加参数
export function getAddChainParams(chainId: number) {
  const config = CHAIN_CONFIGS[chainId]
  if (!config) {
    throw new Error(`Chain ${chainId} not supported`)
  }
  
  return {
    chainId: `0x${chainId.toString(16)}`,
    chainName: config.name,
    nativeCurrency: config.nativeCurrency,
    rpcUrls: [config.rpcUrl],
    blockExplorerUrls: config.blockExplorer ? [config.blockExplorer] : undefined,
  }
}
