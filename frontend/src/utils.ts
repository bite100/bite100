import { BrowserProvider, type Eip1193Provider, type Signer } from 'ethers'

const WIN = typeof window !== 'undefined' ? (window as unknown as { ethereum?: Eip1193Provider }) : null

export function getEthereum(): Eip1193Provider | null {
  return WIN?.ethereum ?? null
}

export function getProvider(): BrowserProvider | null {
  const ethereum = getEthereum()
  if (!ethereum) return null
  return new BrowserProvider(ethereum)
}

/** 获取 signer 并执行回调，未检测到钱包时抛错 */
export async function withSigner<T>(fn: (signer: Signer) => Promise<T>): Promise<T> {
  const provider = getProvider()
  if (!provider) throw new Error('未检测到钱包')
  const signer = await provider.getSigner()
  return fn(signer)
}

/** 将 bigint 转为保留 6 位小数的字符串 */
export function formatTokenAmount(value: bigint | undefined): string {
  if (value == null) return '0'
  return (Number(value) / 1e18).toFixed(6)
}

/** 短地址显示 */
export function shortAddress(addr: string, start = 6, end = 4): string {
  if (!addr || addr.length < start + end) return addr
  return `${addr.slice(0, start)}...${addr.slice(-end)}`
}

/** 校验 0x 地址长度 42 */
export function isValidAddress(addr: string): boolean {
  const s = addr?.trim() ?? ''
  return s.startsWith('0x') && s.length === 42
}
