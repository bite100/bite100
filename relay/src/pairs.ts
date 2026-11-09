/**
 * 自助上架交易对注册表（第六十轮）：地址型 pair 键、链上元数据复读、注册/查询、
 * 下单代币解析与基础限流。设计见 docs/round60-self-listing-2026-11-10.md §3。
 *
 * 口径要点：
 * - 新交易对的 pair 键 = `<chainId>:<base 地址小写>/<quote 地址小写>`，自带链与
 *   双代币地址；订单的 pair 字符串即此键，中继按注册表逐一核对地址。
 * - 种子 8 对保持符号键（BTC/USDT 等），继续走 config.ts 的内置代币表，不入本表。
 * - 元数据不信任提交方：注册时经该链 RPC 链上复读 symbol/name/decimals
 *   （骑 viem publicClient，与 orders.ts 的 ERC-1271 回退同一客户端工厂），
 *   合约无代码 / 元数据不可读 → 拒绝注册（fail-closed）。
 * - 中继无鉴权：creator 只是自报信息（留痕 + 基础限流），不构成准入或背书。
 */
import { erc20Abi, type Address, type PublicClient } from 'viem'
import { pairTokens, type ChainRelayConfig } from './config'
import { defaultGetPublicClient } from './orders'

export interface PairRow {
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

interface PairDbRow {
  chain_id: number
  pair_key: string
  base_token: string
  quote_token: string
  base_symbol: string
  quote_symbol: string
  base_name: string
  quote_name: string
  base_decimals: number
  quote_decimals: number
  creator: string | null
  created_at: number
}

function rowToPair(r: PairDbRow): PairRow {
  return {
    chainId: r.chain_id,
    pairKey: r.pair_key,
    baseToken: r.base_token,
    quoteToken: r.quote_token,
    baseSymbol: r.base_symbol,
    quoteSymbol: r.quote_symbol,
    baseName: r.base_name,
    quoteName: r.quote_name,
    baseDecimals: r.base_decimals,
    quoteDecimals: r.quote_decimals,
    creator: r.creator,
    createdAt: r.created_at,
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const PAIR_KEY_RE = /^(\d+):(0x[0-9a-fA-F]{40})\/(0x[0-9a-fA-F]{40})$/

/** 地址型 pair 键（地址统一小写） */
export function buildPairKey(chainId: number, baseToken: string, quoteToken: string): string {
  return `${chainId}:${baseToken.toLowerCase()}/${quoteToken.toLowerCase()}`
}

/** 解析地址型 pair 键；不是地址键（种子符号键等）返回 null */
export function parsePairKey(
  pair: string,
): { chainId: number; baseToken: string; quoteToken: string } | null {
  const m = PAIR_KEY_RE.exec(pair)
  if (!m) return null
  return {
    chainId: Number(m[1]),
    baseToken: m[2].toLowerCase(),
    quoteToken: m[3].toLowerCase(),
  }
}

export function isAddress(value: unknown): value is string {
  return typeof value === 'string' && ADDRESS_RE.test(value)
}

/**
 * 元数据字符串清洗：去控制字符、折叠空白、截断。symbol 另有严检（见
 * validateSymbol）：含 '/'、':'、空白或为空的的一律拒绝——符号要进 pair 展示串
 * 与 URL，放任分隔符会把展示与键解析搅乱。
 */
export function sanitizeText(v: string, maxLen: number): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen)
}

export function validateSymbol(symbol: string): string | null {
  const s = sanitizeText(symbol, 32)
  if (s === '' || /[\s/:]/.test(s)) return null
  return s
}

export interface TokenMetadata {
  symbol: string
  name: string
  decimals: number
}

/** 链上代币读取的注入点（单测以假件替身；生产走 viem publicClient） */
export interface TokenReader {
  /** 合约代码（'0x'/空 = 无代码） */
  getCode(address: string): Promise<string>
  /** ERC-20 元数据；读不到返回 null */
  readMetadata(address: string): Promise<TokenMetadata | null>
}

export function viemTokenReader(client: PublicClient): TokenReader {
  return {
    async getCode(address) {
      const code = await client.getCode({ address: address as Address })
      return code ?? '0x'
    },
    async readMetadata(address) {
      const a = address as Address
      try {
        const [symbol, name, decimals] = await Promise.all([
          client.readContract({ address: a, abi: erc20Abi, functionName: 'symbol' }),
          client.readContract({ address: a, abi: erc20Abi, functionName: 'name' }),
          client.readContract({ address: a, abi: erc20Abi, functionName: 'decimals' }),
        ])
        const sym = validateSymbol(String(symbol))
        if (!sym) return null
        const nm = sanitizeText(String(name), 128)
        if (nm === '') return null
        const dec = Number(decimals)
        if (!Number.isInteger(dec) || dec < 0 || dec > 255) return null
        return { symbol: sym, name: nm, decimals: dec }
      } catch {
        return null
      }
    },
  }
}

/** 注册错误：带 HTTP 状态，index.ts 据此回响应 */
export class PairRequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

/** 基础限流口径（防灌水，非准入审核；见轮次文档 §3.4） */
export const MAX_PAIRS_PER_CREATOR_PER_DAY = 50
export const MAX_PAIRS_PER_CHAIN_PER_HOUR = 200

export interface RegisterPairInput {
  baseToken: string
  quoteToken: string
  creator?: string | null
}

export interface RegisterPairDeps {
  /** 按链造代币读取器；返回 null 表示该链无 RPC（注册不可用） */
  getTokenReader?: (chain: ChainRelayConfig) => TokenReader | null
  nowSec?: () => number
}

function defaultGetTokenReader(chain: ChainRelayConfig): TokenReader | null {
  const client = defaultGetPublicClient(chain)
  return client ? viemTokenReader(client) : null
}

/** 查注册表一行；不存在返回 null */
export async function getPair(
  db: D1Database,
  chainId: number,
  pairKey: string,
): Promise<PairRow | null> {
  const row = await db
    .prepare('SELECT * FROM pairs WHERE chain_id = ? AND pair_key = ?')
    .bind(chainId, pairKey)
    .first<PairDbRow>()
  return row ? rowToPair(row) : null
}

/** 列某链全部自助上架对（按创建时间升序，封顶 500 行防表被灌爆时拖垮响应） */
export async function listPairs(db: D1Database, chainId: number): Promise<PairRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM pairs WHERE chain_id = ? ORDER BY created_at ASC LIMIT 500')
    .bind(chainId)
    .all<PairDbRow>()
  return (results ?? []).map(rowToPair)
}

/**
 * 注册一个自助上架对：校验 → 幂等查存 → 链上复读元数据 → 限流 → 落库。
 * 元数据以链上复读为准，入参只有地址（+自报 creator）。
 */
export async function registerPair(
  db: D1Database,
  chain: ChainRelayConfig,
  input: RegisterPairInput,
  deps: RegisterPairDeps = {},
): Promise<{ row: PairRow; duplicate: boolean }> {
  if (!isAddress(input.baseToken) || !isAddress(input.quoteToken)) {
    throw new PairRequestError(400, 'invalid token address')
  }
  const base = input.baseToken.toLowerCase()
  const quote = input.quoteToken.toLowerCase()
  if (base === ZERO_ADDRESS || quote === ZERO_ADDRESS) {
    throw new PairRequestError(400, 'zero address token')
  }
  if (base === quote) {
    throw new PairRequestError(400, 'base and quote token must differ')
  }
  let creator: string | null = null
  if (input.creator !== undefined && input.creator !== null && input.creator !== '') {
    if (!isAddress(input.creator)) throw new PairRequestError(400, 'invalid creator')
    creator = input.creator.toLowerCase()
  }

  const pairKey = buildPairKey(chain.chainId, base, quote)
  const existing = await getPair(db, chain.chainId, pairKey)
  if (existing) return { row: existing, duplicate: true }

  const getReader = deps.getTokenReader ?? defaultGetTokenReader
  const reader = getReader(chain)
  if (!reader) {
    throw new PairRequestError(502, 'token metadata read unavailable for this chain')
  }
  const now = (deps.nowSec ?? (() => Math.floor(Date.now() / 1000)))()

  const metas: TokenMetadata[] = []
  for (const token of [base, quote]) {
    let code: string
    try {
      code = await reader.getCode(token)
    } catch {
      throw new PairRequestError(502, `token metadata read failed: ${token}`)
    }
    if (!code || code === '0x') {
      throw new PairRequestError(400, `token has no contract code: ${token}`)
    }
    const meta = await reader.readMetadata(token)
    if (!meta) {
      throw new PairRequestError(400, `token metadata unreadable (not an ERC-20?): ${token}`)
    }
    metas.push(meta)
  }

  // 基础限流：同 creator 每 UTC 日、每链每小时的新增上限（COUNT 现有行）
  if (creator) {
    const dayStart = Math.floor(now / 86400) * 86400
    const row = await db
      .prepare('SELECT COUNT(*) AS n FROM pairs WHERE chain_id = ? AND creator = ? AND created_at >= ?')
      .bind(chain.chainId, creator, dayStart)
      .first<{ n: number }>()
    if ((row?.n ?? 0) >= MAX_PAIRS_PER_CREATOR_PER_DAY) {
      throw new PairRequestError(429, 'daily pair registration limit for creator reached')
    }
  }
  const hourRow = await db
    .prepare('SELECT COUNT(*) AS n FROM pairs WHERE chain_id = ? AND created_at >= ?')
    .bind(chain.chainId, now - 3600)
    .first<{ n: number }>()
  if ((hourRow?.n ?? 0) >= MAX_PAIRS_PER_CHAIN_PER_HOUR) {
    throw new PairRequestError(429, 'hourly pair registration limit for chain reached')
  }

  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO pairs
         (chain_id, pair_key, base_token, quote_token, base_symbol, quote_symbol,
          base_name, quote_name, base_decimals, quote_decimals, creator, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      chain.chainId,
      pairKey,
      base,
      quote,
      metas[0].symbol,
      metas[1].symbol,
      metas[0].name,
      metas[1].name,
      metas[0].decimals,
      metas[1].decimals,
      creator,
      now,
    )
    .run()
  const row = await getPair(db, chain.chainId, pairKey)
  if (!row) throw new PairRequestError(500, 'pair insert failed')
  // INSERT OR IGNORE 未插入 = 并发下已被别人注册：按幂等返回既有行
  return { row, duplicate: (res.meta.changes ?? 0) === 0 }
}

/**
 * 下单代币解析：符号键走种子内置表；地址型键查注册表（键内链必须与订单链
 * 一致、地址与注册行一致）。解析不到返回 null（调用方按 unknown pair 拒绝）。
 */
export async function resolveOrderTokens(
  db: D1Database,
  chain: ChainRelayConfig,
  pair: string,
): Promise<{ tokenIn: string; tokenOut: string } | null> {
  const key = parsePairKey(pair)
  if (!key) return pairTokens(chain, pair)
  if (key.chainId !== chain.chainId) return null
  const row = await getPair(db, chain.chainId, buildPairKey(key.chainId, key.baseToken, key.quoteToken))
  if (!row) return null
  if (row.baseToken !== key.baseToken || row.quoteToken !== key.quoteToken) return null
  return { tokenIn: row.baseToken, tokenOut: row.quoteToken }
}
