// Sepolia 测试网
export const CHAIN_ID = 11155111
export const RPC_URL = 'https://ethereum-sepolia.publicnode.com'

// 已部署合约（Sepolia，含 Mock + AMM）
export const VAULT_ADDRESS = '0xbe3962Eaf7103d05665279469FFE3573352ec70C' as const
export const SETTLEMENT_ADDRESS = '0x493Da680973F6c222c89eeC02922E91F1D9404a0' as const
export const TOKEN0_ADDRESS = '0x678195277dc8F84F787A4694DF42F3489eA757bf' as const // Test Token A
export const TOKEN1_ADDRESS = '0x9Be241a0bF1C2827194333B57278d1676494333a' as const // Test Token B
export const AMM_POOL_ADDRESS = '0x8d392e6b270238c3a05dDB719795eE31ad7c72AF' as const

// 治理与配置（部署后填入：运行 contracts/scripts/deploy-governance.ps1 后按终端提示替换 GOVERNANCE_ADDRESS）
export const CONTRIBUTOR_REWARD_ADDRESS = '0x851019107c4F3150D90f1629f6A646eBC1B1E286' as const
export const GOVERNANCE_ADDRESS = '0x8F107ffaB0FC42E623AA69Bd10d8ad4cfbcE87BB' as const
export const TOKEN_REGISTRY_ADDRESS = '0x77AF51BC13eE8b83274255f4a9077D3E9498c556' as const
export const CHAIN_CONFIG_ADDRESS = '0x7639fc976361752c8d9cb82a41bc5D0F423D5169' as const

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
