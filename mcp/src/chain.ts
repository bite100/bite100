/**
 * 链上只读层：ethers JsonRpcProvider + 最小 ABI 片段（与 soak generator
 * 的最小 ABI 模式同法，不整包引合约 ABI）。接口可注入，便于单测 mock。
 * 本文件只有读，没有任何写路径（块 1 口径）；写侧的合约调用在
 * tools/write.ts 里经 signer 接口完成。
 */
import { ethers } from 'ethers'
import { chainConfig } from './config'

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)']
const VAULT_READ_ABI = [
  'function availableBalance(address,address) view returns (uint256)',
  'function balanceOf(address,address) view returns (uint256)',
  'function orderLocks(bytes32) view returns (address user, address token, uint256 remaining, uint256 expiresAt)',
  'function cancelledOrders(bytes32) view returns (bool)',
]
const SETTLEMENT_READ_ABI = ['function orderFilledIn(bytes32) view returns (uint256)']

export interface LockInfo {
  user: string
  token: string
  remaining: string
  expiresAt: number
}

export interface ChainReader {
  nativeBalance(chainId: number, address: string): Promise<bigint>
  tokenBalance(chainId: number, token: string, address: string): Promise<bigint>
  vaultBalance(chainId: number, token: string, address: string): Promise<bigint>
  vaultAvailable(chainId: number, token: string, address: string): Promise<bigint>
  orderFilledIn(chainId: number, digest: string): Promise<bigint>
  orderLock(chainId: number, digest: string): Promise<LockInfo | null>
  orderCancelled(chainId: number, digest: string): Promise<boolean>
  /** 写工具用的 provider（经 signer 接口连接钱包）；只读工具不调用 */
  provider(chainId: number): ethers.JsonRpcProvider
}

export class EthersChainReader implements ChainReader {
  private providers = new Map<number, ethers.JsonRpcProvider>()

  provider(chainId: number): ethers.JsonRpcProvider {
    let p = this.providers.get(chainId)
    if (!p) {
      p = new ethers.JsonRpcProvider(chainConfig(chainId).rpcUrl)
      this.providers.set(chainId, p)
    }
    return p
  }

  private contract(chainId: number, address: string, abi: string[]): ethers.Contract {
    return new ethers.Contract(address, abi, this.provider(chainId))
  }

  async nativeBalance(chainId: number, address: string): Promise<bigint> {
    return this.provider(chainId).getBalance(address)
  }

  async tokenBalance(chainId: number, token: string, address: string): Promise<bigint> {
    return this.contract(chainId, token, ERC20_ABI).balanceOf(address)
  }

  async vaultBalance(chainId: number, token: string, address: string): Promise<bigint> {
    const v = chainConfig(chainId).contracts.vault
    // 注意：Vault.balanceOf 的参数序是 (token, user)，与 availableBalance
    // 的 (user, token) 相反（Vault.sol:314 vs :166，前端同法调用）。
    return this.contract(chainId, v, VAULT_READ_ABI).balanceOf(token, address)
  }

  async vaultAvailable(chainId: number, token: string, address: string): Promise<bigint> {
    const v = chainConfig(chainId).contracts.vault
    return this.contract(chainId, v, VAULT_READ_ABI).availableBalance(address, token)
  }

  async orderFilledIn(chainId: number, digest: string): Promise<bigint> {
    const s = chainConfig(chainId).contracts.settlement
    return this.contract(chainId, s, SETTLEMENT_READ_ABI).orderFilledIn(digest)
  }

  async orderLock(chainId: number, digest: string): Promise<LockInfo | null> {
    const v = chainConfig(chainId).contracts.vault
    const lock = await this.contract(chainId, v, VAULT_READ_ABI).orderLocks(digest)
    const remaining = BigInt(lock.remaining ?? lock[2] ?? 0n)
    const user = String(lock.user ?? lock[0] ?? ethers.ZeroAddress)
    if (remaining <= 0n || user === ethers.ZeroAddress) return null
    return {
      user,
      token: String(lock.token ?? lock[1]),
      remaining: remaining.toString(),
      expiresAt: Number(lock.expiresAt ?? lock[3] ?? 0n),
    }
  }

  async orderCancelled(chainId: number, digest: string): Promise<boolean> {
    const v = chainConfig(chainId).contracts.vault
    return Boolean(await this.contract(chainId, v, VAULT_READ_ABI).cancelledOrders(digest))
  }
}
