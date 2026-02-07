import type { Eip1193Provider } from 'ethers'

const WIN = typeof window !== 'undefined' ? (window as unknown as { ethereum?: Eip1193Provider }) : null

export function getEthereum(): Eip1193Provider | null {
  return WIN?.ethereum ?? null
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
