/** 工具函数：钱包 Provider、缓存、错误格式化等（仅浏览器/PWA） */
import { BrowserProvider, type Eip1193Provider, type Signer } from 'ethers'

type WinEthereum = {
  ethereum?: Eip1193Provider | Eip1193Provider[]
  phantom?: { ethereum?: Eip1193Provider }
  trustwallet?: Eip1193Provider
  bitget?: Eip1193Provider
  rabby?: Eip1193Provider
  okxwallet?: Eip1193Provider
  coinbaseWallet?: Eip1193Provider
  onekey?: Eip1193Provider
  tokenpocket?: Eip1193Provider
  safepal?: Eip1193Provider
  imToken?: Eip1193Provider
}

const WIN = typeof window !== 'undefined' ? (window as unknown as WinEthereum) : null

function normalizeProvider(p: unknown): Eip1193Provider | null {
  if (!p) return null
  if (Array.isArray(p)) return (p[0] as Eip1193Provider) ?? null
  return p as Eip1193Provider
}

/** 按优先级尝试的 provider 键（Wagmi 只读 window.ethereum，检测到其他键时会在 main 里写入 ethereum） */
const PROVIDER_KEYS: (keyof WinEthereum)[] = [
  'ethereum',
  'trustwallet',
  'phantom', // 使用 WIN.phantom?.ethereum 单独处理
  'bitget',
  'rabby',
  'okxwallet',
  'coinbaseWallet',
  'onekey',
  'tokenpocket',
  'safepal',
  'imToken',
]

function getRawProvider(): unknown {
  if (!WIN) return null
  if (WIN.ethereum) return WIN.ethereum
  if (WIN.phantom?.ethereum) return WIN.phantom.ethereum
  for (const k of PROVIDER_KEYS) {
    if (k === 'ethereum' || k === 'phantom') continue
    const v = WIN[k]
    if (v && typeof (v as Eip1193Provider).request === 'function') return v
  }
  return null
}

export function getEthereum(): Eip1193Provider | null {
  return normalizeProvider(getRawProvider())
}

/**
 * 等待钱包注入（钱包 App 内打开时可能延迟注入）
 * @param timeoutMs 最多等待毫秒数，默认 5000
 */
export function getEthereumAsync(timeoutMs = 5000): Promise<Eip1193Provider | null> {
  const existing = getEthereum()
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const start = Date.now()
    const tick = () => {
      const eth = getEthereum()
      if (eth) {
        resolve(eth)
        return
      }
      if (Date.now() >= deadline) {
        resolve(null)
        return
      }
      // 前 1.5 秒每 80ms 轮询，之后每 200ms
      const elapsed = Date.now() - start
      const interval = elapsed < 1500 ? 80 : 200
      setTimeout(tick, interval)
    }
    setTimeout(tick, 50)
  })
}

export function getProvider(): BrowserProvider | null {
  const ethereum = getEthereum()
  if (!ethereum) return null
  return new BrowserProvider(ethereum)
}

/**
 * 给任意 Promise 套应用层超时（第 54 轮）：超时按失败 reject，由调用方
 * 走既有失败路径。专为不支持取消信号的调用（如经钱包 Provider 的
 * ethers 合约读）兜底——钱包 RPC 卡住时原调用永不落定，界面会永远停在
 * 「加载中」。tradesDual 的 callWithTimeout 面向 fetch（须把 AbortSignal
 * 真传进底层请求），合约读没有 signal 可传，故这里只做竞速；超时后底层
 * 调用仍可能在后台完成，但结果会被丢弃，不会再回写界面。
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/** 链上余额读取超时（第 54 轮）：钱包 RPC 正常时为亚秒级，10 秒足够宽放 */
export const BALANCE_READ_TIMEOUT_MS = 10000

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
  if (msg.includes('connector') && (msg.includes('not found') || msg.includes('missing'))) return '未检测到钱包。请在 MetaMask、Trust 等钱包应用的内置浏览器中打开本页，或安装钱包浏览器扩展。'
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('expired')) return '连接超时。请检查网络后重试，或使用钱包应用的内置浏览器打开。'
  if (msg.includes('fetch failed') || msg.includes('failed to fetch') || msg.includes('econnrefused') || msg.includes('etimedout') || msg.includes('network error') || msg.includes('load failed'))
    return (typeof navigator !== 'undefined' && !navigator.onLine ? '网络异常，当前似乎离线，请检查网络后重试。' : '网络异常，请检查网络后重试；若网络不稳定可稍后重试。')
  if (msg.includes('network') || msg.includes('chain')) return '网络错误，请确认钱包网络与页面所选网络一致'
  const raw = (err.reason ?? err.shortMessage ?? (e as { message?: string }).message ?? String(e)) as string
  if (raw.includes('Governance: not in active set')) return '当前地址不在活跃集内，无法投票'
  if (raw.includes('Governance: already voted')) return '您已投过票'
  if (raw.includes('Governance: voting ended')) return '投票已结束'
  if (raw.includes('Governance: not passed')) return '赞成票未超过半数，无法执行'
  if (raw.includes('CALL_EXCEPTION')) {
    if (raw.includes('insufficient balance')) return '余额不足'
    if (raw.includes('insufficient allowance')) return '授权额度不足，请先完成代币授权'
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
} as const
export const CACHE_TTL = { BALANCE: 20000 }

/** 调试日志工具（仅在开发环境输出） */
const isDev = import.meta.env.DEV || import.meta.env.MODE === 'development'
export const debug = {
  log: (...args: unknown[]) => isDev && console.log(...args),
  error: (...args: unknown[]) => console.error(...args), // 错误始终输出
  warn: (...args: unknown[]) => isDev && console.warn(...args),
}
