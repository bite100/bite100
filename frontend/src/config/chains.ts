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
    feeDistributor: string
    governance: string
    tokenRegistry: string
    chainConfig: string
  }
}

// Sepolia 测试网（2026-11-07 第十五轮重新部署：挂单余额锁定版十合约；见 docs/round15-deployment-2026-11-07.md）
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
    vault: '0x7B6aFdd9799ABa60a4Fd77217b40E8191Dc498f5',
    settlement: '0x929ceb054B86Bf222eb94Df7b75aDa4fD22A538A',
    token0: '0x93a4af54d7cD8aF7c9aEF50D3Dd3977bA1Dde28E',
    token1: '0x1530b74E6d5C2D0e2b78314b5C253E66bfC4ddc2',
    ammPool: '0x744d25a4163Da099c75aF9D10e32704420a76E94',
    contributorReward: '0x12b8dA1b30771c46025488621bfe3DC665E9C0a8',
    feeDistributor: '0x346DE29B7fEe95F44A5b5385e87182F031E8E1B5',
    governance: '0x31900dD9C5190F72A2Da96E3efE45014B5748448',
    tokenRegistry: '0x9d50B1088E483f3A192A018c6a59cb9a5bddeDDd',
    chainConfig: '0x0f419cA52A47d2cA7Ae5f803cf010263012D2cA1',
  },
}

// Base Sepolia 测试网（2026-11-07 第十五轮同构重新部署：挂单余额锁定版十合约；见 docs/round15-deployment-2026-11-07.md）
const BASE_SEPOLIA: ChainConfig = {
  chainId: 84532,
  name: 'Base Sepolia',
  rpcUrl: 'https://sepolia.base.org',
  blockExplorer: 'https://sepolia.basescan.org',
  nativeCurrency: {
    name: 'ETH',
    symbol: 'ETH',
    decimals: 18,
  },
  contracts: {
    vault: '0xd09E808D0978bdD06738a5dAfBd3c0a286aE3Fb2',
    settlement: '0x3F9F29A6Ff7F706Bd769da3f0F4b3dCe70371D4c',
    token0: '0xd3f1136Cb3511b4546BDE5dDAC4F0D5a4D5C5D33',
    token1: '0x8492ccCE958803F04772C0f5B51DbbC320A54daF',
    ammPool: '0x20F25844bC6823325d67fB8aC71cA416601774a1',
    contributorReward: '0xFe066c25a25Fddd6433Fac7f7769d5806392663e',
    feeDistributor: '0xAeC85272Cba4F22eaf93a0313b0D09164Ca009b7',
    governance: '0x26b608468bf5Dd88B91EAE3D16827A2b4a25BCcE',
    tokenRegistry: '0x8dC560038D392012C8562185E4C6Bf2Ce636E74D',
    chainConfig: '0x439423AB16A1A3dadf5415243501ee9e6984b813',
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
    feeDistributor: '0x0000000000000000000000000000000000000000',
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
    feeDistributor: '0x0000000000000000000000000000000000000000',
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
    feeDistributor: '0x0000000000000000000000000000000000000000',
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
    feeDistributor: '0x0000000000000000000000000000000000000000',
    governance: '0x0000000000000000000000000000000000000000',
    tokenRegistry: '0x0000000000000000000000000000000000000000',
    chainConfig: '0x0000000000000000000000000000000000000000',
  },
}

// BSC 主网（可选，待部署）
const BSC: ChainConfig = {
  chainId: 56,
  name: 'BSC',
  rpcUrl: 'https://bsc-dataseed.binance.org',
  blockExplorer: 'https://bscscan.com',
  nativeCurrency: {
    name: 'BNB',
    symbol: 'BNB',
    decimals: 18,
  },
  contracts: {
    vault: '0x0000000000000000000000000000000000000000',
    settlement: '0x0000000000000000000000000000000000000000',
    token0: '0x0000000000000000000000000000000000000000',
    token1: '0x0000000000000000000000000000000000000000',
    ammPool: '0x0000000000000000000000000000000000000000',
    contributorReward: '0x0000000000000000000000000000000000000000',
    feeDistributor: '0x0000000000000000000000000000000000000000',
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
    feeDistributor: '0x0000000000000000000000000000000000000000',
    governance: '0x0000000000000000000000000000000000000000',
    tokenRegistry: '0x0000000000000000000000000000000000000000',
    chainConfig: '0x0000000000000000000000000000000000000000',
  },
}

// 所有链配置
export const CHAIN_CONFIGS: Record<number, ChainConfig> = {
  [SEPOLIA.chainId]: SEPOLIA,
  [BASE_SEPOLIA.chainId]: BASE_SEPOLIA,
  [MAINNET.chainId]: MAINNET,
  [BASE.chainId]: BASE,
  [ARBITRUM.chainId]: ARBITRUM,
  [POLYGON.chainId]: POLYGON,
  [OPTIMISM.chainId]: OPTIMISM,
  [BSC.chainId]: BSC,
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
