import { DEFAULT_CHAIN_ID, getChainConfig } from './config/chains'

// 节点 API 配置（VITE_NODE_API_URL / NODE_API_URL / NODE_API_URLS）已于
// 第 51 轮（阶段 5 节点退役）删除：前端不再直连任何 P2P 节点，订单通道
// 只剩订单中继（config/relay.ts 的 RELAY_URL）与链上索引（config/indexer.ts）。

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
export const CONTRIBUTOR_REWARD_ADDRESS = currentChainConfig.contracts.contributorReward
export const FEE_DISTRIBUTOR_ADDRESS = currentChainConfig.contracts.feeDistributor
export const GOVERNANCE_ADDRESS = currentChainConfig.contracts.governance
export const TOKEN_REGISTRY_ADDRESS = currentChainConfig.contracts.tokenRegistry
export const CHAIN_CONFIG_ADDRESS = currentChainConfig.contracts.chainConfig

// NodeRewards（上线奖励）合约地址：优先使用链配置中的扩展字段，其次使用环境变量
const envNodeRewards = (import.meta.env.VITE_NODE_REWARDS_ADDRESS ?? '').trim()
export const NODE_REWARDS_ADDRESS =
  (currentChainConfig as any).contracts?.nodeRewards && (currentChainConfig as any).contracts.nodeRewards !== '0x0000000000000000000000000000000000000000'
    ? (currentChainConfig as any).contracts.nodeRewards
    : envNodeRewards

// 导出链配置获取函数（供组件使用）
export { getChainConfig, DEFAULT_CHAIN_ID } from './config/chains'

export const VAULT_ABI = [
  'function balanceOf(address token, address user) view returns (uint256)',
  'function locked(address user, address token) view returns (uint256)',
  'function availableBalance(address user, address token) view returns (uint256)',
  'function deposit(address token, uint256 amount)',
  'function withdraw(address token, uint256 amount)',
] as const

export const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
] as const

export const GOVERNANCE_ABI = [
  'function proposalCount() view returns (uint256)',
  // 第 32 轮对齐：合约 getProposal 返回 9 字段，executableAt 在 executed 之前；
  // 旧手工 ABI 缺 executableAt，executableAt 时间戳会被解码成 executed。
  'function getProposal(uint256 proposalId) view returns (address target, bytes memory callData, uint256 activeCount, uint256 createdAt, uint256 votingEndsAt, uint256 yesCount, uint256 noCount, uint256 executableAt, bool executed)',
  // 第 32 轮补齐：治理页多步提案回退读取一直调用此函数，但旧 ABI 缺失，
  // 调用恒抛错、多步提案永远显示不出来。字段顺序与合约 10 字段返回一致。
  'function getMultiStepProposal(uint256 proposalId) view returns (address[] memory targets, bytes[] memory callDataArray, bytes32 merkleRoot, uint256 activeCount, uint256 createdAt, uint256 votingEndsAt, uint256 yesCount, uint256 noCount, uint256 executableAt, bool executed)',
  'function createProposal(address target, bytes calldata callData, bytes32 merkleRoot, uint256 activeCount) returns (uint256)',
  'function vote(uint256 proposalId, bool support, bytes32[] calldata proof)',
  'function execute(uint256 proposalId)',
  'event ProposalCreated(uint256 indexed proposalId, address indexed target, uint256 activeCount)',
  'event Voted(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight)',
  'event ProposalExecuted(uint256 indexed proposalId)',
] as const

export const CONTRIBUTOR_REWARD_ABI = [
  'function getContributionScore(string calldata period, address account) view returns (uint256)',
  'function getPeriodTotalScore(string calldata period) view returns (uint256)',
  'function claimable(string calldata period, address token, address account) view returns (uint256)',
  'function claimableTotal(string calldata period, address token, address account) view returns (uint256)',
  'function claimed(bytes32 periodId, address token, address account) view returns (uint256)',
  'function claimReward(string calldata period, address token)',
  'function periodEndTimestamp(bytes32 periodId) view returns (uint256)',
  'function CLAIM_DEADLINE_SECONDS() view returns (uint256)',
] as const

export const FEE_DISTRIBUTOR_ABI = [
  'function claimable(address token, address account) view returns (uint256)',
  'function claim(address token)',
] as const

// NodeRewards 上线奖励合约 ABI（积分/节点绑定 + 一键领取）
export const NODE_REWARDS_ABI = [
  'function devPoints(address wallet) view returns (uint256)',
  'function nodePoints(address wallet) view returns (uint256)',
  'function getTotalRewards(address wallet) view returns (uint256)',
  'function claimRewards()',
  'function boundNodeCount(address wallet) view returns (uint256)',
  'function bindAndRegister(bytes32 nodeId)',
] as const

/** Settlement 合约：链下撮合后调用 settleTrade 上链验签结算（需 owner/relayer 提交，双方签名订单随 Fill 携带） */
export { SETTLEMENT_ABI } from './services/settlementAbi'
