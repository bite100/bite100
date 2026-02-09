import { DEFAULT_CHAIN_ID, getChainConfig } from './config/chains'

/** 节点 API 根地址（单节点时使用）；多节点时取第一个，实际请求由 nodeClient 按列表依次尝试 */
const _raw = (import.meta.env.VITE_NODE_API_URL ?? '').trim()
export const NODE_API_URL = _raw.split(',')[0]?.replace(/\/$/, '') ?? ''
/** 节点 API 列表（P2P 多节点：逗号分隔多个 URL，请求时依次尝试直至成功） */
export const NODE_API_URLS: string[] = _raw
  ? _raw.split(',').map((u: string) => u.trim().replace(/\/$/, '')).filter(Boolean)
  : []

// P2P 配置（路径 2：浏览器 + 公共 relay，支持多 relay fallback）
const _wsRaw = (import.meta.env.VITE_P2P_WS_URLS ?? import.meta.env.VITE_P2P_WS_URL ?? '').trim()
const _wsList = _wsRaw ? _wsRaw.split(',').map((u: string) => u.trim().replace(/\/$/, '')).filter(Boolean) : []

export const P2P_CONFIG = {
  /** WebSocket 地址（单条，兼容旧逻辑；优先用 RELAY_WS_URLS 列表） */
  WS_URL: _wsList[0] || import.meta.env.VITE_P2P_WS_URL || 'ws://localhost:8080/ws',
  /** Relay WebSocket 列表（逗号分隔，依次尝试直至连接成功；生产示例 wss://relay1.p2p-p2p.xyz/ws,wss://relay2.p2p-p2p.xyz/ws） */
  RELAY_WS_URLS: _wsList.length > 0 ? _wsList : [(import.meta.env.VITE_P2P_WS_URL || 'ws://localhost:8080/ws').toString().trim()],
  /** Go 节点 API 地址（可选；不设则纯浏览器直连） */
  API_URL: import.meta.env.VITE_P2P_API_URL || 'http://localhost:8080',
  /** Bootstrap 节点 multiaddr 列表（逗号分隔，用于 DHT 发现；可选） */
  BOOTSTRAP_PEERS: (import.meta.env.VITE_P2P_BOOTSTRAP ?? '')
    .split(',')
    .map((u: string) => u.trim())
    .filter(Boolean),
}

// 多链配置：从环境变量或默认链获取当前链配置
const initialChainId = import.meta.env.VITE_CHAIN_ID 
  ? parseInt(import.meta.env.VITE_CHAIN_ID, 10)
  : DEFAULT_CHAIN_ID

const currentChainConfig = getChainConfig(initialChainId) || getChainConfig(DEFAULT_CHAIN_ID)!

// 导出当前链配置（动态，可通过链切换更新）
export const CHAIN_ID = currentChainConfig.chainId
export const RPC_URL = currentChainConfig.rpcUrl
export const VAULT_ADDRESS = currentChainConfig.contracts.vault
export const SETTLEMENT_ADDRESS = currentChainConfig.contracts.settlement
export const TOKEN0_ADDRESS = currentChainConfig.contracts.token0
export const TOKEN1_ADDRESS = currentChainConfig.contracts.token1
export const AMM_POOL_ADDRESS = currentChainConfig.contracts.ammPool
export const CONTRIBUTOR_REWARD_ADDRESS = currentChainConfig.contracts.contributorReward
export const GOVERNANCE_ADDRESS = currentChainConfig.contracts.governance
export const TOKEN_REGISTRY_ADDRESS = currentChainConfig.contracts.tokenRegistry
export const CHAIN_CONFIG_ADDRESS = currentChainConfig.contracts.chainConfig

// 导出链配置获取函数（供组件使用）
export { getChainConfig, DEFAULT_CHAIN_ID } from './config/chains'

export const VAULT_ABI = [
  'function balanceOf(address token, address user) view returns (uint256)',
  'function deposit(address token, uint256 amount)',
  'function withdraw(address token, uint256 amount)',
] as const

export const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
] as const

export const AMM_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function reserve0() view returns (uint256)',
  'function reserve1() view returns (uint256)',
  'function getAmountOut(address tokenIn, uint256 amountIn) view returns (uint256)',
  'function swap(address tokenIn, uint256 amountIn) returns (uint256)',
  'function addLiquidity(uint256 amount0, uint256 amount1)',
] as const

export const GOVERNANCE_ABI = [
  'function proposalCount() view returns (uint256)',
  'function getProposal(uint256 proposalId) view returns (address target, bytes memory callData, uint256 activeCount, uint256 createdAt, uint256 votingEndsAt, uint256 yesCount, uint256 noCount, bool executed)',
  'function createProposal(address target, bytes calldata callData, bytes32 merkleRoot, uint256 activeCount) returns (uint256)',
  'function vote(uint256 proposalId, bool support, bytes32[] calldata proof)',
  'function execute(uint256 proposalId)',
  'event ProposalCreated(uint256 indexed proposalId, address target, uint256 activeCount)',
  'event Voted(uint256 indexed proposalId, address indexed voter, bool support)',
  'event ProposalExecuted(uint256 indexed proposalId)',
] as const

export const CONTRIBUTOR_REWARD_ABI = [
  'function getContributionScore(string calldata period, address account) view returns (uint256)',
  'function getPeriodTotalScore(string calldata period) view returns (uint256)',
  'function claimable(string calldata period, address token, address account) view returns (uint256)',
  'function claimed(bytes32 periodId, address token, address account) view returns (uint256)',
  'function claimReward(string calldata period, address token)',
] as const

/** Settlement 合约：链下撮合后调用 settleTrade 上链结算（需 owner/relayer） */
export const SETTLEMENT_ABI = [
  'function settleTrade(address maker, address taker, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 gasReimburseIn, uint256 gasReimburseOut)',
  'event TradeSettled(address indexed maker, address indexed taker, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 feeAmount)',
  'event TradeSettledWithGasReimburse(address indexed maker, address indexed taker, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 feeAmount, uint256 gasReimburseIn, uint256 gasReimburseOut, address indexed gasRecipient)',
] as const
