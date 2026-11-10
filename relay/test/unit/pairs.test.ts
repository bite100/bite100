/**
 * 第六十轮：自助上架注册表单测。
 * registerPair 的 D1 与链上读取都走注入点，这里用内存假 D1 + 假代币
 * 读取器替身：覆盖键构造/解析、符号严检、注册校验（坏地址/同币/零地址/
 * 无代码/元数据不可读）、幂等、基础限流、下单代币解析（种子键与地址键）。
 */
import { describe, expect, it } from 'vitest'
import { BUILTIN_CHAINS } from '../../src/config'
import {
  PairRequestError,
  buildPairKey,
  listPairs,
  parsePairKey,
  registerPair,
  resolveOrderTokens,
  validateSymbol,
  type PairRow,
  type TokenMetadata,
  type TokenReader,
} from '../../src/pairs'

// ---------- 内存假 D1（只实现 pairs.ts 用到的语句形状） ----------
interface DbPairRow {
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

class FakeStmt {
  private binds: unknown[] = []
  constructor(
    private db: FakeD1,
    private sql: string,
  ) {}
  bind(...b: unknown[]) {
    this.binds = b
    return this
  }
  async first<T>(): Promise<T | null> {
    return (this.db.query(this.sql, this.binds)[0] as T) ?? null
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.query(this.sql, this.binds) as T[] }
  }
  async run(): Promise<{ meta: { changes: number } }> {
    return { meta: { changes: this.db.mutate(this.sql, this.binds) } }
  }
}

class FakeD1 {
  rows: DbPairRow[] = []
  prepare(sql: string) {
    return new FakeStmt(this, sql)
  }
  query(sql: string, b: unknown[]): unknown[] {
    if (sql.includes('COUNT(*)')) {
      let rows = this.rows.filter((r) => r.chain_id === b[0])
      if (sql.includes('creator = ?')) {
        rows = rows.filter((r) => r.creator === b[1] && r.created_at >= (b[2] as number))
      } else if (sql.includes('creator IS NULL')) {
        rows = rows.filter((r) => r.creator === null && r.created_at >= (b[1] as number))
      } else if (sql.includes('created_at >= ?')) {
        rows = rows.filter((r) => r.created_at >= (b[1] as number))
      }
      // 否则是 listPairs 的 total 计数（只有 chain 绑定）
      return [{ n: rows.length }]
    }
    if (sql.includes('pair_key = ?')) {
      return this.rows.filter((r) => r.chain_id === b[0] && r.pair_key === b[1])
    }
    if (sql.includes('FROM pairs')) {
      const rows = this.rows
        .filter((r) => r.chain_id === b[0])
        .sort((x, y) => x.created_at - y.created_at)
      // listPairs 分页形状：binds = (chain, limit, offset)
      if (sql.includes('LIMIT ? OFFSET ?')) {
        return rows.slice(b[2] as number, (b[2] as number) + (b[1] as number))
      }
      return rows
    }
    throw new Error(`fake d1: unhandled query ${sql}`)
  }
  mutate(sql: string, b: unknown[]): number {
    if (!sql.includes('INSERT OR IGNORE INTO pairs')) {
      throw new Error(`fake d1: unhandled mutation ${sql}`)
    }
    const [chain_id, pair_key, base_token, quote_token, base_symbol, quote_symbol,
      base_name, quote_name, base_decimals, quote_decimals, creator, created_at] =
      b as [number, string, string, string, string, string, string, string, number, number, string | null, number]
    if (this.rows.some((r) => r.chain_id === chain_id && r.pair_key === pair_key)) return 0
    if (sql.includes('SELECT')) {
      // 第 59 轮带门 INSERT：binds[12..] = (chain, creatorKey, dayStart,
      // creatorCap, chain, hourStart, chainCap)；任一谓词不满足 → 0 行
      const creatorCount = this.rows.filter(
        (r) =>
          r.chain_id === b[12] &&
          (r.creator ?? '') === b[13] &&
          r.created_at >= (b[14] as number),
      ).length
      if (creatorCount >= (b[15] as number)) return 0
      const chainCount = this.rows.filter(
        (r) => r.chain_id === b[16] && r.created_at >= (b[17] as number),
      ).length
      if (chainCount >= (b[18] as number)) return 0
    }
    this.rows.push({
      chain_id, pair_key, base_token, quote_token, base_symbol, quote_symbol,
      base_name, quote_name, base_decimals, quote_decimals, creator, created_at,
    })
    return 1
  }
}

// ---------- 假代币读取器 ----------
const TOKENS: Record<string, { code: string; meta: TokenMetadata | null }> = {}
function fakeReader(): TokenReader {
  return {
    async getCode(address) {
      return TOKENS[address.toLowerCase()]?.code ?? '0x'
    },
    async readMetadata(address) {
      return TOKENS[address.toLowerCase()]?.meta ?? null
    },
  }
}

const CHAIN = BUILTIN_CHAINS[11155111]
const BASE = '0x1111111111111111111111111111111111111111'
const QUOTE = '0x2222222222222222222222222222222222222222'
const CREATOR = '0x3333333333333333333333333333333333333333'

function seedTokens() {
  TOKENS[BASE] = { code: '0x6001', meta: { symbol: 'TKX6', name: 'Token X Six', decimals: 6 } }
  TOKENS[QUOTE] = { code: '0x6001', meta: { symbol: 'USDT', name: 'Tether USD', decimals: 18 } }
}

function asD1(db: FakeD1): D1Database {
  return db as unknown as D1Database
}

describe('pair 键构造与解析', () => {
  it('构造：地址小写、带链前缀；解析可往返', () => {
    const key = buildPairKey(11155111, '0xAbC0000000000000000000000000000000000001', QUOTE)
    expect(key).toBe(`11155111:0xabc0000000000000000000000000000000000001/${QUOTE}`)
    expect(parsePairKey(key)).toEqual({
      chainId: 11155111,
      baseToken: '0xabc0000000000000000000000000000000000001',
      quoteToken: QUOTE,
    })
  })
  it('种子符号键与畸形键解析为 null', () => {
    expect(parsePairKey('BTC/USDT')).toBeNull()
    expect(parsePairKey('11155111:0x123/0x456')).toBeNull()
    expect(parsePairKey('abc:0x1111111111111111111111111111111111111111/0x2222222222222222222222222222222222222222')).toBeNull()
    expect(parsePairKey('')).toBeNull()
  })
})

describe('validateSymbol', () => {
  it('正常符号通过；含分隔符/空白/空的一律拒绝', () => {
    expect(validateSymbol('TKX6')).toBe('TKX6')
    expect(validateSymbol('A/B')).toBeNull()
    expect(validateSymbol('A:B')).toBeNull()
    expect(validateSymbol('A B')).toBeNull()
    expect(validateSymbol('')).toBeNull()
    expect(validateSymbol('   ')).toBeNull()
  })
})

describe('registerPair', () => {
  it('正常注册：元数据以链上复读为准，键为地址型', async () => {
    seedTokens()
    const db = new FakeD1()
    const { row, duplicate } = await registerPair(
      asD1(db),
      CHAIN,
      { baseToken: BASE, quoteToken: QUOTE, creator: CREATOR },
      { getTokenReader: () => fakeReader(), nowSec: () => 1_700_000_000 },
    )
    expect(duplicate).toBe(false)
    expect(row.pairKey).toBe(buildPairKey(11155111, BASE, QUOTE))
    expect(row.baseSymbol).toBe('TKX6')
    expect(row.baseDecimals).toBe(6)
    expect(row.quoteDecimals).toBe(18)
    expect(row.creator).toBe(CREATOR)
  })

  it('重复注册幂等：第二次 duplicate=true 且不新增行', async () => {
    seedTokens()
    const db = new FakeD1()
    const deps = { getTokenReader: () => fakeReader(), nowSec: () => 1_700_000_000 }
    await registerPair(asD1(db), CHAIN, { baseToken: BASE, quoteToken: QUOTE }, deps)
    const again = await registerPair(asD1(db), CHAIN, { baseToken: BASE, quoteToken: QUOTE }, deps)
    expect(again.duplicate).toBe(true)
    expect(db.rows.length).toBe(1)
  })

  it('坏地址 / 同币 / 零地址 → 400', async () => {
    seedTokens()
    const db = new FakeD1()
    const deps = { getTokenReader: () => fakeReader() }
    await expect(
      registerPair(asD1(db), CHAIN, { baseToken: '0x123', quoteToken: QUOTE }, deps),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      registerPair(asD1(db), CHAIN, { baseToken: BASE, quoteToken: BASE }, deps),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      registerPair(
        asD1(db),
        CHAIN,
        { baseToken: '0x0000000000000000000000000000000000000000', quoteToken: QUOTE },
        deps,
      ),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('无合约代码 / 元数据不可读 → 400 拒绝（fail-closed）', async () => {
    const db = new FakeD1()
    TOKENS[BASE] = { code: '0x', meta: null }
    TOKENS[QUOTE] = { code: '0x6001', meta: { symbol: 'USDT', name: 'Tether', decimals: 18 } }
    await expect(
      registerPair(asD1(db), CHAIN, { baseToken: BASE, quoteToken: QUOTE }, { getTokenReader: () => fakeReader() }),
    ).rejects.toMatchObject({ status: 400 })
    TOKENS[BASE] = { code: '0x6001', meta: null }
    await expect(
      registerPair(asD1(db), CHAIN, { baseToken: BASE, quoteToken: QUOTE }, { getTokenReader: () => fakeReader() }),
    ).rejects.toMatchObject({ status: 400 })
    expect(db.rows.length).toBe(0)
  })

  it('无 RPC 读取器 → 502', async () => {
    seedTokens()
    const db = new FakeD1()
    await expect(
      registerPair(asD1(db), CHAIN, { baseToken: BASE, quoteToken: QUOTE }, { getTokenReader: () => null }),
    ).rejects.toBeInstanceOf(PairRequestError)
  })

  it('creator 日限：同 creator 当日第 51 个被 429', async () => {
    seedTokens()
    const db = new FakeD1()
    const now = 1_700_000_000
    for (let i = 0; i < 50; i++) {
      db.rows.push({
        chain_id: 11155111,
        pair_key: `k${i}`,
        base_token: BASE,
        quote_token: QUOTE,
        base_symbol: 'A',
        quote_symbol: 'B',
        base_name: 'a',
        quote_name: 'b',
        base_decimals: 18,
        quote_decimals: 18,
        creator: CREATOR,
        created_at: now - 60,
      })
    }
    await expect(
      registerPair(
        asD1(db),
        CHAIN,
        { baseToken: BASE, quoteToken: QUOTE, creator: CREATOR },
        { getTokenReader: () => fakeReader(), nowSec: () => now },
      ),
    ).rejects.toMatchObject({ status: 429 })
  })
})

describe('resolveOrderTokens', () => {
  it('种子符号键走内置表（不查注册表）', async () => {
    const db = new FakeD1()
    const t = await resolveOrderTokens(asD1(db), CHAIN, 'BTC/USDT')
    expect(t).toEqual({
      tokenIn: CHAIN.tokens.BTC,
      tokenOut: CHAIN.tokens.USDT,
    })
    expect(await resolveOrderTokens(asD1(db), CHAIN, 'FOO/BAR')).toBeNull()
  })

  it('地址键：已注册可解析；未注册/链不一致/地址被换都返回 null', async () => {
    seedTokens()
    const db = new FakeD1()
    await registerPair(
      asD1(db),
      CHAIN,
      { baseToken: BASE, quoteToken: QUOTE },
      { getTokenReader: () => fakeReader(), nowSec: () => 1_700_000_000 },
    )
    const key = buildPairKey(11155111, BASE, QUOTE)
    expect(await resolveOrderTokens(asD1(db), CHAIN, key)).toEqual({
      tokenIn: BASE,
      tokenOut: QUOTE,
    })
    // 未注册的地址键
    expect(
      await resolveOrderTokens(asD1(db), CHAIN, buildPairKey(11155111, QUOTE, BASE)),
    ).toBeNull()
    // 键内链与订单链不一致
    expect(
      await resolveOrderTokens(asD1(db), BUILTIN_CHAINS[84532], key),
    ).toBeNull()
  })
})

describe('registerPair 第 59 轮（限流前置 / 匿名桶 / 条件 INSERT / decimals）', () => {
  const BASE2 = '0x4444444444444444444444444444444444444444'
  const QUOTE2 = '0x5555555555555555555555555555555555555555'

  function seedRow(creator: string | null, i: number, now: number) {
    return {
      chain_id: 11155111,
      pair_key: `seed-${creator ?? 'anon'}-${i}`,
      base_token: BASE,
      quote_token: QUOTE,
      base_symbol: 'A',
      quote_symbol: 'B',
      base_name: 'a',
      quote_name: 'b',
      base_decimals: 18,
      quote_decimals: 18,
      creator,
      created_at: now - 60,
    }
  }

  function countingReader() {
    let calls = 0
    const inner = fakeReader()
    const reader: TokenReader = {
      async getCode(a) {
        calls++
        return inner.getCode(a)
      },
      async readMetadata(a) {
        return inner.readMetadata(a)
      },
    }
    return { reader, calls: () => calls }
  }

  it('限流前置：creator 已满 50/日 → 429 且一次 RPC 读都不发（审计 P1-1）', async () => {
    seedTokens()
    const db = new FakeD1()
    const now = 1_700_000_000
    for (let i = 0; i < 50; i++) db.rows.push(seedRow(CREATOR, i, now))
    const { reader, calls } = countingReader()
    await expect(
      registerPair(
        asD1(db),
        CHAIN,
        { baseToken: BASE, quoteToken: QUOTE, creator: CREATOR },
        { getTokenReader: () => reader, nowSec: () => now },
      ),
    ).rejects.toMatchObject({ status: 429 })
    expect(calls()).toBe(0)
  })

  it('匿名桶：无 creator 的注册同受 50/日（审计 ④）；实名桶与其独立', async () => {
    seedTokens()
    const db = new FakeD1()
    const now = 1_700_000_000
    for (let i = 0; i < 50; i++) db.rows.push(seedRow(null, i, now))
    const { reader, calls } = countingReader()
    await expect(
      registerPair(
        asD1(db),
        CHAIN,
        { baseToken: BASE, quoteToken: QUOTE },
        { getTokenReader: () => reader, nowSec: () => now },
      ),
    ).rejects.toMatchObject({ status: 429 })
    expect(calls()).toBe(0)
    // 带 creator 的注册不被匿名桶牵连
    const ok = await registerPair(
      asD1(db),
      CHAIN,
      { baseToken: BASE, quoteToken: QUOTE, creator: CREATOR },
      { getTokenReader: () => fakeReader(), nowSec: () => now },
    )
    expect(ok.duplicate).toBe(false)
  })

  it('原子性：49/50 时两笔并发注册恰一笔成功、一笔 429，总行数停在 50', async () => {
    seedTokens()
    TOKENS[BASE2] = { code: '0x6001', meta: { symbol: 'TKY6', name: 'Token Y Six', decimals: 6 } }
    TOKENS[QUOTE2] = { code: '0x6001', meta: { symbol: 'USDT', name: 'Tether USD', decimals: 18 } }
    const db = new FakeD1()
    const now = 1_700_000_000
    for (let i = 0; i < 49; i++) db.rows.push(seedRow(CREATOR, i, now))
    const deps = { getTokenReader: () => fakeReader(), nowSec: () => now }
    const results = await Promise.allSettled([
      registerPair(asD1(db), CHAIN, { baseToken: BASE, quoteToken: QUOTE, creator: CREATOR }, deps),
      registerPair(asD1(db), CHAIN, { baseToken: BASE2, quoteToken: QUOTE2, creator: CREATOR }, deps),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 429 })
    expect(db.rows).toHaveLength(50)
  })

  it('decimals 范围：单币 >36 或 18+quote-base <0 → 400 且不落库（审计 P2-2）', async () => {
    const db = new FakeD1()
    TOKENS[BASE] = { code: '0x6001', meta: { symbol: 'BIG', name: 'Big Decimals', decimals: 40 } }
    TOKENS[QUOTE] = { code: '0x6001', meta: { symbol: 'USDT', name: 'Tether USD', decimals: 18 } }
    await expect(
      registerPair(asD1(db), CHAIN, { baseToken: BASE, quoteToken: QUOTE }, { getTokenReader: () => fakeReader() }),
    ).rejects.toMatchObject({ status: 400 })
    TOKENS[BASE] = { code: '0x6001', meta: { symbol: 'B30', name: 'Base 30', decimals: 30 } }
    TOKENS[QUOTE] = { code: '0x6001', meta: { symbol: 'Q6', name: 'Quote 6', decimals: 6 } }
    await expect(
      registerPair(asD1(db), CHAIN, { baseToken: BASE, quoteToken: QUOTE }, { getTokenReader: () => fakeReader() }),
    ).rejects.toMatchObject({ status: 400 })
    expect(db.rows).toHaveLength(0)
    seedTokens()
  })
})

describe('listPairs 分页（第 59 轮块 4，审计 P3-1）', () => {
  it('limit/offset/total/truncated 口径', async () => {
    seedTokens()
    const B2 = '0x4444444444444444444444444444444444444444'
    const Q2 = '0x5555555555555555555555555555555555555555'
    TOKENS[B2] = { code: '0x6001', meta: { symbol: 'TKY6', name: 'Token Y Six', decimals: 6 } }
    TOKENS[Q2] = { code: '0x6001', meta: { symbol: 'USDT', name: 'Tether USD', decimals: 18 } }
    const db = new FakeD1()
    const deps = { getTokenReader: () => fakeReader(), nowSec: () => 1_700_000_000 }
    await registerPair(asD1(db), CHAIN, { baseToken: BASE, quoteToken: QUOTE }, deps)
    await registerPair(asD1(db), CHAIN, { baseToken: B2, quoteToken: Q2 }, deps)

    const page1 = await listPairs(asD1(db), 11155111, { limit: 1 })
    expect(page1.rows).toHaveLength(1)
    expect(page1.total).toBe(2)
    expect(page1.truncated).toBe(true)
    const page2 = await listPairs(asD1(db), 11155111, { limit: 1, offset: 1 })
    expect(page2.rows).toHaveLength(1)
    expect(page2.total).toBe(2)
    expect(page2.truncated).toBe(false)
    const all = await listPairs(asD1(db), 11155111)
    expect(all.rows).toHaveLength(2)
    expect(all.truncated).toBe(false)
  })
})
