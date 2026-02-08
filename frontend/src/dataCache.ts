/**
 * 手机端/弱网：订单簿、成交、我的订单 本地缓存
 * 用于离线或网络差时展示最近数据，并标注为「缓存」
 */
const PREFIX = 'p2p_orderbook_'
const TTL_MS = 5 * 60 * 1000 // 5 分钟

function safeStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

function get<T>(key: string): { data: T; cachedAt: number } | null {
  const storage = safeStorage()
  if (!storage) return null
  try {
    const raw = storage.getItem(PREFIX + key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { data: T; cachedAt: number }
    if (Number.isFinite(parsed.cachedAt) && parsed.data != null) return parsed
    return null
  } catch {
    return null
  }
}

/** 读取缓存；若过期或不存在返回 null */
export function getCached<T>(key: string): T | null {
  const entry = get<T>(key)
  if (!entry || Date.now() - entry.cachedAt > TTL_MS) return null
  return entry.data
}

/** 缓存是否有效（未过期） */
export function isCacheValid(key: string): boolean {
  const entry = get<unknown>(key)
  return !!entry && Date.now() - entry.cachedAt <= TTL_MS
}

/** 写入缓存 */
export function setCached(key: string, data: unknown): void {
  const storage = safeStorage()
  if (!storage) return
  try {
    storage.setItem(PREFIX + key, JSON.stringify({ data, cachedAt: Date.now() }))
  } catch {
    // quota / private mode
  }
}

export const CACHE_KEYS_ORDERBOOK = {
  orderbook: (pair: string) => `orderbook_${pair}`,
  trades: (pair: string) => `trades_${pair}`,
  myOrders: (account: string, pair: string) => `myOrders_${account}_${pair}`,
} as const
