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
    contributorReward: string
    feeDistributor: string
    governance: string
    tokenRegistry: string
    chainConfig: string
    crossChainBridge: string
    // 第十九轮：WrappedTKA（TKA 的 1:1 包装代币，CCIP / Wormhole 桥的载体代币）
    wrappedToken?: string
    // 第 53 轮：做市金库 MakerVault 产品退役——地址配置随前端下线一并删除
    // （实例已暂停、合约代码保留在仓库；部署地址见 docs/round53-makervault-retirement-2026-11-09.md）。
  }
  // 第二十五轮：本链已部署的测试代币（符号 → 地址），供交易对切换器取下单/余额代币；
  // TKA/TKB 沿用 contracts.token0/token1 的地址，此处一并登记以便按符号统一取用。
  tokens?: {
    [symbol: string]: string
  }
  // 第十九轮：Chainlink CCIP 通道配置（官方 BurnMintTokenPool + 官方 Router）
  ccip?: {
    router: string
    tokenPool: string
    // CCIP 链选择器是 uint64 大整数，必须以字符串保存，避免 JS 精度丢失
    chainSelector: string
    tokenAdminRegistry: string
  }
  // 第十九轮：Wormhole 通道配置（官方 NTT：NttManager + WormholeTransceiver）
  wormhole?: {
    coreBridge: string
    nttManager: string
    nttTransceiver: string
    // Wormhole 自己的链 ID（与 EVM chainId 不同）
    wormholeChainId: number
  }
  // 第二十三轮：Chainlink 预言机喂价配置（参考价层；前端只读，不参与结算/签名）
  chainlinkFeeds?: {
    // key = 交易对（BASE/QUOTE，如 ETH/USD）；只有真实存在官方喂价的交易对才配，
    // 测试代币 TKA/TKB 没有任何外部喂价，禁止在此映射到其他资产的价格。
    [pair: string]: {
      // AggregatorV3 代理合约地址（官方文档 Price Feed Addresses）
      address: string
      // 官方心跳（秒）：无偏差触发时喂价的最长更新间隔；时效阈值按它推导
      heartbeatSec: number
    }
  }
}

// Sepolia 测试网（2026-11-07 第十五轮重新部署：挂单余额锁定版十合约；见 docs/round15-deployment-2026-11-07.md；
// 跨链桥为第十六轮迁移部署，见 docs/round16-bridge-migration-2026-11-07.md；
// 第二十一轮仅 Vault/Settlement/ChainConfig 三合约换新为 gas 规则版，其余沿用，见 docs/round21-gas-rules-2026-11-07.md）
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
    vault: '0x836cEFF0140aB66D8DD984ECb18765736BA121e9',
    settlement: '0x5697F7B2178352eB391e29fc2c5681Dea864C1d9',
    token0: '0x93a4af54d7cD8aF7c9aEF50D3Dd3977bA1Dde28E',
    token1: '0x1530b74E6d5C2D0e2b78314b5C253E66bfC4ddc2',
    contributorReward: '0x12b8dA1b30771c46025488621bfe3DC665E9C0a8',
    feeDistributor: '0x346DE29B7fEe95F44A5b5385e87182F031E8E1B5',
    governance: '0x31900dD9C5190F72A2Da96E3efE45014B5748448',
    tokenRegistry: '0x9d50B1088E483f3A192A018c6a59cb9a5bddeDDd',
    chainConfig: '0x52De0F096B169f612E55084eE05Efa7D1dEaa0c4',
    crossChainBridge: '0x7a0eCbc2Ffca2F8f7A1505Fa65e7E4759bE33d50',
    wrappedToken: '0x03ED8203236Bb5409caA6330fDCd16559C914b9a',
  },
  // 第十九轮 CCIP（见 docs/round19-three-bridges-2026-11-07.md）
  ccip: {
    router: '0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59',
    tokenPool: '0x68Bf313360021DcF4E359aD18c4506f622A3666d',
    chainSelector: '16015286601757825753',
    tokenAdminRegistry: '0x95F29FEE11c5C55d26cCcf1DB6772DE953B37B82',
  },
  // 第十九轮 Wormhole NTT（burning 模式，一致性等级 15 = finalized）
  wormhole: {
    coreBridge: '0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78',
    nttManager: '0x5a6Da05af0d9eF61BA85f610556357bEb1DC57D1',
    nttTransceiver: '0x1bFb42E93F5860C76ef0E100E063083357b93C8A',
    wormholeChainId: 10002,
  },
  // 第二十五轮 Chainlink 喂价（官方文档 Price Feed Addresses / API Reference 示例；
  // 2026-11-07 实读 description()="ETH / USD"、decimals=8 验证，见 docs/round23-oracle-reference-price-2026-11-07.md）
  // 新增：BTC/USDT 用 BTC/USD 喂价（美元计价；USDT 约等于 1 美元，故该喂价是 BTC/USDT 对的诚实参考价，
  // 映射关系见 docs/round25-mainstream-pairs-2026-11-07.md §3）；ETH/USDT 同理复用 ETH/USD 喂价。
  // 其余新对（SOL/BNB/XRP/DOGE/LINK/USDT）未在官方清单与链上实读中找到已核实喂价，故不配——
  // 参考价层按第二十三轮口径走本所成交/盘口兜底，面板无数据时明说「新市场，暂无参考价」。
  chainlinkFeeds: {
    'ETH/USD': { address: '0x694AA1769357215DE4FAC081bf1f309aDC325306', heartbeatSec: 3600 },
    'BTC/USDT': { address: '0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43', heartbeatSec: 3600 },
    'ETH/USDT': { address: '0x694AA1769357215DE4FAC081bf1f309aDC325306', heartbeatSec: 3600 },
  },
  // 第二十五轮：主流测试币（MockERC20，18 位；部署见 docs/round25-mainstream-pairs-2026-11-07.md §1）
  tokens: {
    TKA: '0x93a4af54d7cD8aF7c9aEF50D3Dd3977bA1Dde28E',
    TKB: '0x1530b74E6d5C2D0e2b78314b5C253E66bfC4ddc2',
    BTC: '0x8EDa0025C245B10eA1E10c257674B794C85350f3',
    ETH: '0x6851ec177dB923ae0A97F262351437D12B21710A',
    SOL: '0x42f7B1B6c2caFb1F3d930B0C247a08f608b034aa',
    BNB: '0x5657f5DBb2C49DBCd4F6d16ebbCb3D4870aACd29',
    XRP: '0x20191571978478AEea15BC39b7D5609BE343D88e',
    DOGE: '0xAb2D18f97E2dd39450bf1C0E59BC4d2Fb23212C7',
    LINK: '0x74159771935E66Ed7dC13370f2BCe89EC8292b18',
    USDT: '0x6Ca8cb68Ee5BB15474f1cfFE07B895C974Ab9c6e',
  },
}

// Base Sepolia 测试网（2026-11-07 第十五轮同构重新部署：挂单余额锁定版十合约；见 docs/round15-deployment-2026-11-07.md；
// 跨链桥为第十六轮迁移部署，见 docs/round16-bridge-migration-2026-11-07.md；
// 第二十一轮仅 Vault/Settlement/ChainConfig 三合约换新为 gas 规则版，其余沿用，见 docs/round21-gas-rules-2026-11-07.md）
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
    vault: '0x295F5529F5BfA4cA39290f395b1feF7EA637f5D3',
    settlement: '0x1021C7116cCE59f9c85683d6f1b5aD2215795949',
    token0: '0xd3f1136Cb3511b4546BDE5dDAC4F0D5a4D5C5D33',
    token1: '0x8492ccCE958803F04772C0f5B51DbbC320A54daF',
    contributorReward: '0xFe066c25a25Fddd6433Fac7f7769d5806392663e',
    feeDistributor: '0xAeC85272Cba4F22eaf93a0313b0D09164Ca009b7',
    governance: '0x26b608468bf5Dd88B91EAE3D16827A2b4a25BCcE',
    tokenRegistry: '0x8dC560038D392012C8562185E4C6Bf2Ce636E74D',
    chainConfig: '0x41b12b6620750564a412b294a1a2bBde24a3B9E8',
    crossChainBridge: '0xA7722A0ba7F2DA1d4D67D5191222C5e4c3835dBB',
    // 注意：Base Sepolia 的 wTKA 地址字符串与 Sepolia 的 FeeDistributor 相同，是不同链上的不同合约；
    // Base Sepolia 的 CCIP 池地址字符串又与 Sepolia 的 TKA 相同（CREATE nonce 巧合），引用时务必连链一起看。
    wrappedToken: '0x346DE29B7fEe95F44A5b5385e87182F031E8E1B5',
  },
  // 第十九轮 CCIP（见 docs/round19-three-bridges-2026-11-07.md）
  ccip: {
    router: '0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93',
    tokenPool: '0x93a4af54d7cD8aF7c9aEF50D3Dd3977bA1Dde28E',
    chainSelector: '10344971235874465080',
    tokenAdminRegistry: '0x736D0bBb318c1B27Ff686cd19804094E66250e17',
  },
  // 第十九轮 Wormhole NTT（burning 模式，一致性等级 15 = finalized）
  wormhole: {
    coreBridge: '0x79A1027a6A159502049F10906D333EC57E95F083',
    nttManager: '0x9E45CCB3A5fef0E72bB8e97450b7FcF97EFC4d72',
    nttTransceiver: '0x74da43aF57134AFa610ADB8fdA1031594b9a494f',
    wormholeChainId: 10004,
  },
  // 第二十三轮 Chainlink 喂价（官方 Price Feed Addresses 的 Base Sepolia ETH/USD 代理；
  // 2026-11-07 实读 description()="ETH / USD"、decimals=8 验证，心跳 1200s/偏差 0.15%）
  // 第二十五轮新增：ETH/USDT 复用 ETH/USD 喂价（美元计价，USDT 约等于 1 美元；见 Sepolia 段注释与
  // docs/round25-mainstream-pairs-2026-11-07.md §3）。BTC/USDT 在 Base Sepolia 未找到已核实喂价，
  // 故不配；SOL/BNB/XRP/DOGE/LINK/USDT 两链均无已核实喂价，均不配（参考价走本所数据兜底）。
  chainlinkFeeds: {
    'ETH/USD': { address: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1', heartbeatSec: 1200 },
    'ETH/USDT': { address: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1', heartbeatSec: 1200 },
  },
  // 第二十五轮：主流测试币（MockERC20，18 位；部署见 docs/round25-mainstream-pairs-2026-11-07.md §1）
  tokens: {
    TKA: '0xd3f1136Cb3511b4546BDE5dDAC4F0D5a4D5C5D33',
    TKB: '0x8492ccCE958803F04772C0f5B51DbbC320A54daF',
    BTC: '0xf1a6d8fd31fe9e72664fb9f07ffab8056a84156f',
    ETH: '0x151c6be0d525880626f4757d58cd141872af7914',
    SOL: '0xcb704487d52ccf66cae7680c348966e15fa0e430',
    BNB: '0xf567c000f53c76e14fa21c4b90efecc0e4d586ec',
    XRP: '0x26b58d2528a7fdfe744da338c5605123ea2266f3',
    DOGE: '0x68bf313360021dcf4e359ad18c4506f622a3666d',
    LINK: '0x43dc5f7099d3689d0dc73dbdc1e73e7a47e636e2',
    USDT: '0xaab464e0be805c199007e27d8f651038319207d6',
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
    contributorReward: '0x0000000000000000000000000000000000000000',
    feeDistributor: '0x0000000000000000000000000000000000000000',
    governance: '0x0000000000000000000000000000000000000000',
    tokenRegistry: '0x0000000000000000000000000000000000000000',
    chainConfig: '0x0000000000000000000000000000000000000000',
    crossChainBridge: '0x0000000000000000000000000000000000000000',
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
    contributorReward: '0x0000000000000000000000000000000000000000',
    feeDistributor: '0x0000000000000000000000000000000000000000',
    governance: '0x0000000000000000000000000000000000000000',
    tokenRegistry: '0x0000000000000000000000000000000000000000',
    chainConfig: '0x0000000000000000000000000000000000000000',
    crossChainBridge: '0x0000000000000000000000000000000000000000',
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
    contributorReward: '0x0000000000000000000000000000000000000000',
    feeDistributor: '0x0000000000000000000000000000000000000000',
    governance: '0x0000000000000000000000000000000000000000',
    tokenRegistry: '0x0000000000000000000000000000000000000000',
    chainConfig: '0x0000000000000000000000000000000000000000',
    crossChainBridge: '0x0000000000000000000000000000000000000000',
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
    contributorReward: '0x0000000000000000000000000000000000000000',
    feeDistributor: '0x0000000000000000000000000000000000000000',
    governance: '0x0000000000000000000000000000000000000000',
    tokenRegistry: '0x0000000000000000000000000000000000000000',
    chainConfig: '0x0000000000000000000000000000000000000000',
    crossChainBridge: '0x0000000000000000000000000000000000000000',
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
    contributorReward: '0x0000000000000000000000000000000000000000',
    feeDistributor: '0x0000000000000000000000000000000000000000',
    governance: '0x0000000000000000000000000000000000000000',
    tokenRegistry: '0x0000000000000000000000000000000000000000',
    chainConfig: '0x0000000000000000000000000000000000000000',
    crossChainBridge: '0x0000000000000000000000000000000000000000',
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
    contributorReward: '0x0000000000000000000000000000000000000000',
    feeDistributor: '0x0000000000000000000000000000000000000000',
    governance: '0x0000000000000000000000000000000000000000',
    tokenRegistry: '0x0000000000000000000000000000000000000000',
    chainConfig: '0x0000000000000000000000000000000000000000',
    crossChainBridge: '0x0000000000000000000000000000000000000000',
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
