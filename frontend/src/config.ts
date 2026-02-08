const network = import.meta.env.VITE_NETWORK ?? 'sepolia' // sepolia | mainnet | polygon
/** 节点 API 根地址（单节点时使用）；多节点时取第一个，实际请求由 nodeClient 按列表依次尝试 */
const _raw = (import.meta.env.VITE_NODE_API_URL ?? '').trim()
export const NODE_API_URL = _raw.split(',')[0]?.replace(/\/$/, '') ?? ''
/** 节点 API 列表（P2P 多节点：逗号分隔多个 URL，请求时依次尝试直至成功） */
export const NODE_API_URLS: string[] = _raw
  ? _raw.split(',').map((u) => u.trim().replace(/\/$/, '')).filter(Boolean)
  : []

// P2P 配置（客户端 JS-libp2p + 可选 Go 节点桥接）
export const P2P_CONFIG = {
  /** WebSocket 地址（连接 Go 节点时用；纯客户端 P2P 可留空） */
  WS_URL: import.meta.env.VITE_P2P_WS_URL || 'ws://localhost:8080/ws',
  /** Go 节点 API 地址（可选后备；不设则纯浏览器/Electron 直连） */
  API_URL: import.meta.env.VITE_P2P_API_URL || 'http://localhost:8080',
  /** Bootstrap 节点 multiaddr 列表（逗号分隔，用于 DHT 发现；可选） */
  BOOTSTRAP_PEERS: (import.meta.env.VITE_P2P_BOOTSTRAP ?? '')
    .split(',')
    .map((u: string) => u.trim())
    .filter(Boolean),
}

// 网络配置
export const CHAIN_ID = network === 'mainnet' ? 1 : network === 'polygon' ? 137 : 11155111
export const RPC_URL =
  network === 'mainnet' ? 'https://ethereum.publicnode.com'
  : network === 'polygon' ? 'https://polygon-rpc.com'
  : 'https://ethereum-sepolia.publicnode.com'

// 合约地址（主网/Polygon：部署后把脚本输出填入下方；Sepolia：已部署）
const MAINNET = {
  VAULT: '0x0000000000000000000000000000000000000000',
  SETTLEMENT: '0x0000000000000000000000000000000000000000',
  TOKEN0: '0x0000000000000000000000000000000000000000',
  TOKEN1: '0x0000000000000000000000000000000000000000',
  AMM_POOL: '0x0000000000000000000000000000000000000000',
  CONTRIBUTOR_REWARD: '0x0000000000000000000000000000000000000000',
  GOVERNANCE: '0x0000000000000000000000000000000000000000',
  TOKEN_REGISTRY: '0x0000000000000000000000000000000000000000',
  CHAIN_CONFIG: '0x0000000000000000000000000000000000000000',
}
const POLYGON = {
  VAULT: '0x0000000000000000000000000000000000000000',
  SETTLEMENT: '0x0000000000000000000000000000000000000000',
  TOKEN0: '0x0000000000000000000000000000000000000000',
  TOKEN1: '0x0000000000000000000000000000000000000000',
  AMM_POOL: '0x0000000000000000000000000000000000000000',
  CONTRIBUTOR_REWARD: '0x0000000000000000000000000000000000000000',
  GOVERNANCE: '0x0000000000000000000000000000000000000000',
  TOKEN_REGISTRY: '0x0000000000000000000000000000000000000000',
  CHAIN_CONFIG: '0x0000000000000000000000000000000000000000',
}
const SEPOLIA = {
  VAULT: '0xbe3962Eaf7103d05665279469FFE3573352ec70C',
  SETTLEMENT: '0x493Da680973F6c222c89eeC02922E91F1D9404a0',
  TOKEN0: '0x678195277dc8F84F787A4694DF42F3489eA757bf',
  TOKEN1: '0x9Be241a0bF1C2827194333B57278d1676494333a',
  AMM_POOL: '0x8d392e6b270238c3a05dDB719795eE31ad7c72AF',
  CONTRIBUTOR_REWARD: '0x851019107c4F3150D90f1629f6A646eBC1B1E286',
  GOVERNANCE: '0x8F107ffaB0FC42E623AA69Bd10d8ad4cfbcE87BB',
  TOKEN_REGISTRY: '0x77AF51BC13eE8b83274255f4a9077D3E9498c556',
  CHAIN_CONFIG: '0x7639fc976361752c8d9cb82a41bc5D0F423D5169',
}
const addr = network === 'mainnet' ? MAINNET : network === 'polygon' ? POLYGON : SEPOLIA
export const VAULT_ADDRESS = addr.VAULT as const
export const SETTLEMENT_ADDRESS = addr.SETTLEMENT as const
export const TOKEN0_ADDRESS = addr.TOKEN0 as const
export const TOKEN1_ADDRESS = addr.TOKEN1 as const
export const AMM_POOL_ADDRESS = addr.AMM_POOL as const
export const CONTRIBUTOR_REWARD_ADDRESS = addr.CONTRIBUTOR_REWARD as const
export const GOVERNANCE_ADDRESS = addr.GOVERNANCE as const
export const TOKEN_REGISTRY_ADDRESS = addr.TOKEN_REGISTRY as const
export const CHAIN_CONFIG_ADDRESS = addr.CHAIN_CONFIG as const

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
