/**
 * 交易对解析层（第六十轮，用户自助上架）：把「交易对字符串」解析为带地址、
 * 符号与小数位的完整信息，供选对、下单、盘口展示、参考价共用。
 *
 * 两类交易对：
 * - 种子对（符号键，如 BTC/USDT）：第 25 轮的 8 个内置对，代币地址取自
 *   chains.ts 的 tokens 登记，代币均为 18 位 MockERC20（部署文档口径）。
 * - 自助上架对（地址型键 `<chainId>:<base地址>/<quote地址>`，地址小写）：
 *   任何人经上架页把代币地址注册进中继的 pairs 注册表（relay/ 第 60 轮），
 *   元数据（symbol/name/decimals）是中继注册时链上复读的值，前端只读注册表，
 *   不凭空编造。键格式与 relay/src/pairs.ts 逐字一致。
 *
 * decimals 换算口径（第 60 轮文档 §2）：签名 price 的缩放 = 18 + quote 位数
 * − base 位数；数量缩放 = base 位数。种子对两位都是 18，缩放退化为现行 18，
 * 行为与第 60 轮之前逐位一致。换算一律骑 ethers 的 parseUnits/formatUnits。
 */
import { Contract, JsonRpcProvider, formatUnits, parseUnits } from 'ethers'
import { getChainConfig } from '../config/chains'
import { RELAY_URL } from '../config/relay'
import { withTimeout } from '../utils'

export interface TokenMeta {
  address: string
  symbol: string
  name: string
  decimals: number
}

export interface ListedPair {
  chainId: number
  pairKey: string
  base: TokenMeta
  quote: TokenMeta
  creator: string | null
  createdAt: number
}

export interface ResolvedPair {
  /** 规范交易对字符串：种子 = 符号键；自助 = 地址型键 */
  pair: string
  /** 展示用「BASE/QUOTE」（符号取元数据，不把地址键直接示人） */
  displayPair: string
  base: TokenMeta
  quote: TokenMeta
  source: 'seed' | 'listed'
}

/** 种子代币的小数位：第 25 轮部署的 MockERC20 均为 18 位（部署文档口径） */
export const SEED_TOKEN_DECIMALS = 18

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const PAIR_KEY_RE = /^(\d+):(0x[0-9a-fA-F]{40})\/(0x[0-9a-fA-F]{40})$/

export function isAddress(v: unknown): v is string {
  return typeof v === 'string' && ADDRESS_RE.test(v)
}

/** 地址型 pair 键（与中继 relay/src/pairs.ts 的 buildPairKey 逐字一致） */
export function buildPairKey(chainId: number, baseToken: string, quoteToken: string): string {
  return `${chainId}:${baseToken.toLowerCase()}/${quoteToken.toLowerCase()}`
}

/** 解析地址型 pair 键；种子符号键等返回 null */
export function parsePairKey(
  pair: string,
): { chainId: number; baseToken: string; quoteToken: string } | null {
  const m = PAIR_KEY_RE.exec(pair)
  if (!m) return null
  return { chainId: Number(m[1]), baseToken: m[2].toLowerCase(), quoteToken: m[3].toLowerCase() }
}

export function isListedPairKey(pair: string): boolean {
  return parsePairKey(pair) !== null
}

/** 种子对解析：地址取 chains.ts 登记，元数据按已知部署口径（符号即键、18 位） */
export function resolveSeedPair(chainId: number, pair: string): ResolvedPair | null {
  const cfg = getChainConfig(chainId)
  if (!cfg?.tokens) return null
  const [baseSym, quoteSym] = pair.split('/')
  if (!baseSym || !quoteSym) return null
  const baseAddr = cfg.tokens[baseSym]
  const quoteAddr = cfg.tokens[quoteSym]
  if (!baseAddr || !quoteAddr) return null
  return {
    pair,
    displayPair: pair,
    base: { address: baseAddr, symbol: baseSym, name: baseSym, decimals: SEED_TOKEN_DECIMALS },
    quote: { address: quoteAddr, symbol: quoteSym, name: quoteSym, decimals: SEED_TOKEN_DECIMALS },
    source: 'seed',
  }
}

// ---------- 中继注册表客户端（模块级缓存；失败不缓存，下次可重试） ----------

const listedCache = new Map<number, ListedPair[]>()
const listedInflight = new Map<number, Promise<ListedPair[]>>()

interface RelayPairJson {
  chainId: number
  pairKey: string
  baseToken: string
  quoteToken: string
  baseSymbol: string
  quoteSymbol: string
  baseName: string
  quoteName: string
  baseDecimals: number
  quoteDecimals: number
  creator: string | null
  createdAt: number
}

function relayPairToListed(r: RelayPairJson): ListedPair {
  return {
    chainId: r.chainId,
    pairKey: r.pairKey,
    base: {
      address: r.baseToken,
      symbol: r.baseSymbol,
      name: r.baseName,
      decimals: r.baseDecimals,
    },
    quote: {
      address: r.quoteToken,
      symbol: r.quoteSymbol,
      name: r.quoteName,
      decimals: r.quoteDecimals,
    },
    creator: r.creator ?? null,
    createdAt: r.createdAt,
  }
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

/**
 * 拉某链的自助上架对列表（中继 GET /pairs）。超时 8 秒（第 54 轮有界纪律）；
 * 中继未配置/失败 → 返回已缓存值或空数组（选对界面据此只显示种子对，不崩）。
 */
export async function fetchListedPairs(
  chainId: number,
  opts: { force?: boolean; fetchFn?: FetchFn } = {},
): Promise<ListedPair[]> {
  if (!opts.force) {
    const cached = listedCache.get(chainId)
    if (cached) return cached
    const inflight = listedInflight.get(chainId)
    if (inflight) return inflight
  }
  if (!RELAY_URL) return []
  const fetchFn = opts.fetchFn ?? ((url: string, init?: RequestInit) => fetch(url, init))
  const p = (async () => {
    try {
      const res = await withTimeout(
        fetchFn(`${RELAY_URL}/pairs?chain=${chainId}`, {
          signal: AbortSignal.timeout(8000),
        }),
        8000,
        'relay pairs',
      )
      if (!res.ok) return listedCache.get(chainId) ?? []
      const data = (await res.json()) as RelayPairJson[]
      const rows = Array.isArray(data) ? data.map(relayPairToListed) : []
      listedCache.set(chainId, rows)
      return rows
    } catch {
      return listedCache.get(chainId) ?? []
    } finally {
      listedInflight.delete(chainId)
    }
  })()
  listedInflight.set(chainId, p)
  return p
}

/** 同步读缓存中的自助对（未拉取过返回 undefined） */
export function getCachedListedPairs(chainId: number): ListedPair[] | undefined {
  return listedCache.get(chainId)
}

export function getCachedListedPair(chainId: number, pairKey: string): ListedPair | undefined {
  return listedCache.get(chainId)?.find((p) => p.pairKey === pairKey)
}

/** 把一行注册表记录并入缓存（注册成功后本地立即可用，不等下一次拉取） */
export function primeListedPair(row: ListedPair): void {
  const rows = listedCache.get(row.chainId) ?? []
  if (!rows.some((p) => p.pairKey === row.pairKey)) {
    listedCache.set(row.chainId, [...rows, row])
  }
}

/** 向中继注册一个自助上架对；中继拒收时抛带原因文本的 Error */
export async function registerPairOnRelay(
  chainId: number,
  baseToken: string,
  quoteToken: string,
  creator?: string | null,
  fetchFn: FetchFn = (url: string, init?: RequestInit) => fetch(url, init),
): Promise<{ pair: ListedPair; duplicate: boolean }> {
  if (!RELAY_URL) throw new Error('订单中继未配置（VITE_RELAY_URL 为空），暂时无法上架')
  const res = await withTimeout(
    fetchFn(`${RELAY_URL}/pairs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chainId, baseToken, quoteToken, creator: creator ?? undefined }),
      signal: AbortSignal.timeout(15000),
    }),
    15000,
    'relay register pair',
  )
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`中继拒收注册（HTTP ${res.status}）${text ? `：${text}` : ''}`)
  }
  const data = (await res.json()) as { pair: RelayPairJson; duplicate?: boolean }
  const pair = relayPairToListed(data.pair)
  primeListedPair(pair)
  return { pair, duplicate: data.duplicate === true }
}

// ---------- 同步解析（种子直解；自助对查缓存，未命中返回 null 由 hook 触发拉取） ----------

export function resolvePair(chainId: number, pair: string): ResolvedPair | null {
  if (!isListedPairKey(pair)) return resolveSeedPair(chainId, pair)
  const key = parsePairKey(pair)
  if (!key || key.chainId !== chainId) return null
  const row = getCachedListedPair(chainId, buildPairKey(key.chainId, key.baseToken, key.quoteToken))
  if (!row) return null
  return {
    pair: row.pairKey,
    displayPair: `${row.base.symbol}/${row.quote.symbol}`,
    base: row.base,
    quote: row.quote,
    source: 'listed',
  }
}

// ---------- decimals 换算（骑 ethers parseUnits/formatUnits） ----------

/** 签名 price 的缩放位数：18 + quote 位数 − base 位数（第 60 轮文档 §2） */
export function priceDecimalsFor(base: TokenMeta, quote: TokenMeta): number {
  return 18 + quote.decimals - base.decimals
}

/** 人类价格（quote/base）→ 签名 price 原始整数字符串 */
export function humanPriceToRaw(price: string, resolved: ResolvedPair): string {
  return parseUnits(price, priceDecimalsFor(resolved.base, resolved.quote)).toString()
}

/** 签名 price 原始值 → 人类价格数值（展示/估算用，浮点口径与既有展示层一致） */
export function rawPriceToHuman(raw: string | bigint, resolved: ResolvedPair): number {
  const n = Number(formatUnits(raw, priceDecimalsFor(resolved.base, resolved.quote)))
  return Number.isFinite(n) ? n : NaN
}

/** 人类数量（base 单位）→ amountIn 原始整数字符串 */
export function humanAmountToRaw(amount: string, resolved: ResolvedPair): string {
  return parseUnits(amount, resolved.base.decimals).toString()
}

/** amountIn 原始值 → 人类数量数值（展示用） */
export function rawAmountToHuman(raw: string | bigint, resolved: ResolvedPair): number {
  const n = Number(formatUnits(raw, resolved.base.decimals))
  return Number.isFinite(n) ? n : NaN
}

/** 原始整数 → 人类单位纯文本（去尾零，供订单簿行等「人类单位字符串」接口回填） */
export function rawToPlain(raw: string | bigint, decimals: number): string {
  let s: string
  try {
    s = formatUnits(raw, decimals)
  } catch {
    return '0'
  }
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  return s === '' || s === '-0' ? '0' : s
}

// ---------- 链上元数据读取（上架页预览用；注册时中继会再复读一次为准） ----------

export const ERC20_METADATA_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
] as const

/** 符号严检（与中继同口径）：含分隔符/空白/为空的符号不可登记 */
export function validateTokenSymbol(symbol: string): string | null {
  const s = symbol.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 32)
  if (s === '' || /[\s/:]/.test(s)) return null
  return s
}

/**
 * 链上直读一个代币的元数据：先查合约代码存在，再读 name/symbol/decimals；
 * 任一步失败返回 null（不是 ERC-20 / 地址无合约 / 读不到，调用方如实提示）。
 * provider 缺省按链配置的公开 RPC 新建（不依赖钱包连接）。
 */
export async function readTokenMetadata(
  chainId: number,
  address: string,
  provider?: JsonRpcProvider,
): Promise<TokenMeta | null> {
  if (!isAddress(address)) return null
  const cfg = getChainConfig(chainId)
  if (!cfg) return null
  const p = provider ?? new JsonRpcProvider(cfg.rpcUrl)
  try {
    const code = await withTimeout(p.getCode(address), 10000, 'token code')
    if (!code || code === '0x') return null
    const c = new Contract(address, ERC20_METADATA_ABI, p)
    const [name, symbol, decimals] = await withTimeout(
      Promise.all([c.name(), c.symbol(), c.decimals()]),
      10000,
      'token metadata',
    )
    const sym = validateTokenSymbol(String(symbol))
    if (!sym) return null
    const nm = String(name).replace(/\s+/g, ' ').trim().slice(0, 128)
    if (nm === '') return null
    const dec = Number(decimals)
    if (!Number.isInteger(dec) || dec < 0 || dec > 255) return null
    return { address: address.toLowerCase(), symbol: sym, name: nm, decimals: dec }
  } catch {
    return null
  }
}
