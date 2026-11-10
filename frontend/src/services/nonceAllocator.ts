/**
 * 第 62 轮：无序位图 nonce 客户端分配器。
 *
 * 背景：Settlement 的 nonce 语义已从单调水位改为 Permit2 式无序位图
 * （见 docs/eip712-order-spec.md §2/§4.5）——位图位在**结算时**才置位，
 * 链上看不到「已签未结」的在途订单。因此分配不能只读链：同一用户连下
 * 两单时，两单必须拿到不同 nonce，否则按独占规则只有先结的一张能结。
 * 本分配器把 stage-4 跑手生成器已验证的「本地游标」模式推广到全部
 * 客户端（网页 + MCP 借 fetchOrderNonce 共用）：
 *
 * - 游标按 (chainId, userAddress) 隔离，存 localStorage（不可用时降级
 *   为进程内内存 Map，如 MCP 的 Node/Worker 运行时）；
 * - 游标状态 = { cursor, inFlight }：cursor 是下一个候选（单调前进的
 *   提示），inFlight 是本客户端已签发、尚未在链上位图观察到消耗的
 *   nonce 集合（在途占用）；
 * - 每次分配先按链上位图修剪 inFlight（已置位 = 已结/已失效，释放），
 *   再从 cursor 起扫描：跳过链上已置位与 inFlight 占用的位，取第一个
 *   空位。游标与链上冲突时（他端已消耗本地候选）扫描自然越过置位，
 *   等价于以链上为准重新播种；
 * - 首次无游标时从 word 0 起扫描播种。
 *
 * 诚实边界：多端同钱包（多浏览器/多设备，或 localStorage 被清）时，
 * 他端的在途订单对本端不可见，撞号窗口只能缩小不能根除——中继侧
 * POST /orders 的在途撞号拒绝（第 62 轮块 D）是第二道兜底；链上独占
 * 规则是最终裁决。
 */

export interface NonceCursorState {
  /** 下一个候选 nonce（单调前进提示） */
  cursor: number
  /** 本客户端已签发且尚未观察到链上消耗的 nonce（在途占用） */
  inFlight: number[]
}

export interface NonceWordReader {
  /** 读签名者在 Settlement 上的 nonceBitmap 字（wordPos → 256 位字） */
  readWord(wordPos: number): Promise<bigint>
}

export interface NonceCursorStorage {
  load(): NonceCursorState | null
  save(state: NonceCursorState): void
}

export function nonceCursorStorageKey(chainId: number, userAddress: string): string {
  return `bit100:nonce-cursor:${chainId}:${userAddress.toLowerCase()}`
}

const memoryFallback = new Map<string, NonceCursorState>()

function cloneState(s: NonceCursorState): NonceCursorState {
  return { cursor: s.cursor, inFlight: [...s.inFlight] }
}

function parseState(raw: string | null): NonceCursorState | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<NonceCursorState>
    if (typeof v.cursor !== 'number' || !Array.isArray(v.inFlight)) return null
    return {
      cursor: Math.max(0, Math.floor(v.cursor)),
      inFlight: v.inFlight.filter((n) => Number.isSafeInteger(n) && n >= 0),
    }
  } catch {
    return null
  }
}

/** localStorage 持久化存储；不可用（Node/Worker/隐私模式）时降级为内存 Map */
export function createNonceCursorStorage(key: string): NonceCursorStorage {
  return {
    load() {
      try {
        const s = parseState(globalThis.localStorage?.getItem(key) ?? null)
        if (s) return s
      } catch {
        /* 降级到内存 */
      }
      const m = memoryFallback.get(key)
      return m ? cloneState(m) : null
    },
    save(state: NonceCursorState) {
      memoryFallback.set(key, cloneState(state))
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify(state))
      } catch {
        /* 内存副本已存 */
      }
    },
  }
}

/** 测试/注入用：纯内存存储 */
export function createMemoryNonceCursorStorage(
  initial: NonceCursorState | null = null,
): NonceCursorStorage & { current(): NonceCursorState | null } {
  let state = initial ? cloneState(initial) : null
  return {
    load: () => (state ? cloneState(state) : null),
    save: (s: NonceCursorState) => {
      state = cloneState(s)
    },
    current: () => (state ? cloneState(state) : null),
  }
}

const BITS_PER_WORD = 256

function bitOf(word: bigint, bitPos: number): boolean {
  return ((word >> BigInt(bitPos)) & 1n) === 1n
}

/**
 * 分配一个 nonce：链上未消耗、且不被本客户端在途订单占用。
 * 返回后该 nonce 进入 inFlight 并持久化，cursor 前进到其后一位。
 */
export async function allocateNonce(
  reader: NonceWordReader,
  storage: NonceCursorStorage,
): Promise<number> {
  const state = storage.load() ?? { cursor: 0, inFlight: [] }

  const wordCache = new Map<number, bigint>()
  const readWord = async (wordPos: number): Promise<bigint> => {
    const hit = wordCache.get(wordPos)
    if (hit !== undefined) return hit
    const w = await reader.readWord(wordPos)
    wordCache.set(wordPos, w)
    return w
  }

  // 修剪 inFlight：链上已置位（已结算消耗或已失效）的不再占用
  const inFlight = new Set<number>()
  for (const n of state.inFlight) {
    const word = await readWord(Math.floor(n / BITS_PER_WORD))
    if (!bitOf(word, n % BITS_PER_WORD)) inFlight.add(n)
  }

  // 从游标起扫描第一个空位（链上未置位 且 不在在途集合）
  let candidate = Math.max(0, Math.floor(state.cursor) || 0)
  for (;;) {
    const word = await readWord(Math.floor(candidate / BITS_PER_WORD))
    if (!bitOf(word, candidate % BITS_PER_WORD) && !inFlight.has(candidate)) break
    candidate++
  }

  inFlight.add(candidate)
  storage.save({
    cursor: candidate + 1,
    inFlight: [...inFlight].sort((a, b) => a - b),
  })
  return candidate
}
