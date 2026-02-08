import { BrowserProvider, type Eip1193Provider, type Signer } from 'ethers'

const WIN = typeof window !== 'undefined' ? (window as unknown as { ethereum?: Eip1193Provider }) : null

export function getEthereum(): Eip1193Provider | null {
  // 在 Electron 中，等待扩展注入完成
  if (isElectron() && typeof window !== 'undefined') {
    // 直接访问 window.ethereum（扩展会注入）
    const eth = (window as any).ethereum
    if (eth) {
      return eth as Eip1193Provider
    }
  }
  return WIN?.ethereum ?? null
}

/** 是否在 Electron 桌面版内运行（无浏览器扩展） */
export function isElectron(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('electron')
}

/** 浏览器版本 URL */
export const BROWSER_APP_URL = 'https://p2p-p2p.github.io/p2p/'

/**
 * 在 Electron 环境中打开浏览器版本
 * @returns 是否成功打开浏览器
 */
export async function openBrowserVersion(): Promise<boolean> {
  if (!isElectron()) {
    return false
  }
  
  try {
    const electronUtils = window.electronUtils
    if (electronUtils && typeof electronUtils.openExternal === 'function') {
      debug.log('🌐 正在打开浏览器版本...')
      const result = await electronUtils.openExternal(BROWSER_APP_URL)
      return result?.success === true
    }
  } catch (err) {
    debug.error('打开浏览器失败:', err)
  }
  
  return false
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

/** 将合约/钱包错误转为用户可读提示（统一用于 App、Governance、Contribution、OrderBook） */
export function formatError(e: unknown): string {
  if (e == null) return '操作失败'
  const err = e as { code?: number; reason?: string; message?: string; shortMessage?: string; data?: unknown }
  const msg = (err.reason ?? err.shortMessage ?? err.message ?? String(e)).toLowerCase()
  if (err.code === 4001 || msg.includes('user rejected') || msg.includes('denied')) return '您已拒绝签名或切换网络'
  if (msg.includes('fetch failed') || msg.includes('failed to fetch') || msg.includes('econnrefused') || msg.includes('etimedout') || msg.includes('network error') || msg.includes('load failed'))
    return (typeof navigator !== 'undefined' && !navigator.onLine ? '网络异常，当前似乎离线，请检查网络后重试。' : '网络异常，请检查网络后重试；若网络不稳定可稍后重试。')
  if (msg.includes('network') || msg.includes('chain')) return '网络错误，请确认已切换到正确网络（Sepolia / 主网 / Polygon）'
  const raw = (err.reason ?? err.shortMessage ?? (e as { message?: string }).message ?? String(e)) as string
  if (raw.includes('Governance: not in active set')) return '当前地址不在活跃集内，无法投票'
  if (raw.includes('Governance: already voted')) return '您已投过票'
  if (raw.includes('Governance: voting ended')) return '投票已结束'
  if (raw.includes('Governance: not passed')) return '赞成票未超过半数，无法执行'
  if (raw.includes('CALL_EXCEPTION')) {
    if (raw.includes('insufficient balance')) return '余额不足'
    if (raw.includes('insufficient allowance')) return '授权额度不足，请先 Approve'
    if (raw.includes('execution reverted')) {
      const m = raw.match(/reverted[:\s]+["']?([^"']+)["']?/i) || raw.match(/reason="([^"]+)"/)
      if (m?.[1]) return m[1]
    }
  }
  if (raw.length > 80) return raw.slice(0, 77) + '...'
  return raw
}

/** 简单内存缓存（带 TTL），用于链上只读数据，减少 RPC 请求 */
const cacheStore: Record<string, { value: unknown; expires: number }> = {}

export function cacheGet<T>(key: string): T | null {
  const entry = cacheStore[key]
  if (!entry || Date.now() > entry.expires) return null
  return entry.value as T
}

export function cacheSet(key: string, value: unknown, ttlMs: number) {
  cacheStore[key] = { value, expires: Date.now() + ttlMs }
}

export function cacheInvalidate(keyPrefix: string) {
  for (const k of Object.keys(cacheStore)) {
    if (k.startsWith(keyPrefix)) delete cacheStore[k]
  }
}

/** 缓存 key 前缀与 TTL（毫秒） */
export const CACHE_KEYS = {
  BALANCE: 'p2p_balance_',
  RESERVES: 'p2p_reserves',
  SWAP_PREVIEW: 'p2p_swap_',
} as const
export const CACHE_TTL = { BALANCE: 20000, RESERVES: 15000, SWAP_PREVIEW: 10000 }

/** 调试日志工具（仅在开发环境输出） */
const isDev = import.meta.env.DEV || import.meta.env.MODE === 'development'
export const debug = {
  log: (...args: unknown[]) => isDev && console.log(...args),
  error: (...args: unknown[]) => console.error(...args), // 错误始终输出
  warn: (...args: unknown[]) => isDev && console.warn(...args),
}
