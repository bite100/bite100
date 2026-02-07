const isMainnet = import.meta.env.VITE_NETWORK === 'mainnet'

// 网络配置（VITE_NETWORK=mainnet 时为主网）
export const CHAIN_ID = isMainnet ? 1 : 11155111
export const RPC_URL = isMainnet ? 'https://ethereum.publicnode.com' : 'https://ethereum-sepolia.publicnode.com'

// 合约地址（主网：部署后运行 deploy-mainnet.ps1，将输出地址填入下方 MAINNET；Sepolia：已部署）
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
const addr = isMainnet ? MAINNET : SEPOLIA
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
