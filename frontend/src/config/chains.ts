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

// Sepolia 测试网（2026-11-07 新部署：十合约全部署——核心六 + 治理/贡献者奖励/代币注册表/链配置）
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
    vault: '0xb4945C5E0208803FF11d0f86173B55489aE87d2A',
    settlement: '0xee35587f3e3f500de9f9E1E97c340F801dc71078',
    token0: '0x903cdDF52963D9DEA0BDF8be9159E08706683654',
    token1: '0x1Ee28c1c490727e49939C95032C749ea5b58b45f',
    ammPool: '0x20a78bCb39Ff510AdBa3D3AEC9229a9583C5BDB3',
    contributorReward: '0xfe066c25a25fddd6433fac7f7769d5806392663e',
    feeDistributor: '0xB63a3D858E5230233e4D1B76052387C2274d6e3A',
    governance: '0x26b608468bf5dd88b91eae3d16827a2b4a25bcce',
    tokenRegistry: '0x8dc560038d392012c8562185e4c6bf2ce636e74d',
    chainConfig: '0x439423ab16a1a3dadf5415243501ee9e6984b813',
  },
}

// Base Sepolia 测试网（2026-11-07 同构部署：十合约全套，与 Sepolia 同构；见 docs/base-sepolia-deployment-2026-11-07.md）
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
    vault: '0xfb458224973c91ddBa3Fb5B55DAD337038768b21',
    settlement: '0x1f81caafa089cfbeb953fc88d272d0a6181e2985',
    token0: '0x1ee28c1c490727e49939c95032c749ea5b58b45f',
    token1: '0x20a78bcb39ff510adba3d3aec9229a9583c5bdb3',
    ammPool: '0x46ac37629a76b6cadce8bc21e5463c6f433bf29b',
    contributorReward: '0x7f9371C8a519014eC1ec2Ade4388B627Ec82F8F5',
    feeDistributor: '0xa4eaa449360239e1f719608236d087c23379d5a6',
    governance: '0x59e4416C5ca7CB977d8225E5E38088B7c801eaeF',
    tokenRegistry: '0x924A2ac5B56709a9284fB6f99e611F669006F8A7',
    chainConfig: '0xFD170979c08Ab8f06cc01ea9D34CbD2478B6e93c',
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
