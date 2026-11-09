/**
 * 交易对解析层单元测试（第六十轮）：
 * - 地址型 pair 键的构造/解析（与中继 relay/src/pairs.ts 同口径）；
 * - 种子对解析（地址取 chains 登记、18 位）；
 * - decimals 换算（6 位 base × 18 位 quote：价格缩放 30、数量缩放 6）；
 * - 注册表客户端（拉取解析+缓存、注册成功并入缓存后可解析、失败不编造）。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../config/relay', () => ({
  RELAY_URL: 'http://relay.test',
  RELAY_CONFIGURED: true,
}))

import {
  buildPairKey,
  parsePairKey,
  isListedPairKey,
  resolveSeedPair,
  resolvePair,
  fetchListedPairs,
  registerPairOnRelay,
  validateTokenSymbol,
  priceDecimalsFor,
  humanPriceToRaw,
  rawPriceToHuman,
  humanAmountToRaw,
  rawAmountToHuman,
  rawToPlain,
  type ResolvedPair,
} from './pairRegistry'

const SEPOLIA = 11155111
const BASE_ADDR = '0x1111111111111111111111111111111111111111'
const QUOTE_ADDR = '0x2222222222222222222222222222222222222222'
const KEY = buildPairKey(SEPOLIA, BASE_ADDR, QUOTE_ADDR)

describe('pair 键构造/解析', () => {
  it('地址型键：链号 + 小写地址，往返一致', () => {
    expect(KEY).toBe(`${SEPOLIA}:${BASE_ADDR}/${QUOTE_ADDR}`)
    expect(parsePairKey(KEY)).toEqual({
      chainId: SEPOLIA,
      baseToken: BASE_ADDR,
      quoteToken: QUOTE_ADDR,
    })
    expect(isListedPairKey(KEY)).toBe(true)
  })

  it('种子符号键不是地址型键', () => {
    expect(parsePairKey('BTC/USDT')).toBeNull()
    expect(isListedPairKey('BTC/USDT')).toBe(false)
    expect(parsePairKey('not-a-pair')).toBeNull()
    expect(parsePairKey(`${SEPOLIA}:${BASE_ADDR}`)).toBeNull()
  })

  it('大写地址也接受并规范为小写', () => {
    const upper = `${SEPOLIA}:${BASE_ADDR.toUpperCase().replace('0X', '0x')}/${QUOTE_ADDR.toUpperCase().replace('0X', '0x')}`
    expect(parsePairKey(upper)?.baseToken).toBe(BASE_ADDR)
  })
})

describe('种子对解析', () => {
  it('ETH/USDT @ Sepolia：种子来源、地址取 chains 登记、18 位', () => {
    const r = resolveSeedPair(SEPOLIA, 'ETH/USDT')
    expect(r?.source).toBe('seed')
    expect(r?.displayPair).toBe('ETH/USDT')
    expect(r?.base.decimals).toBe(18)
    expect(r?.quote.decimals).toBe(18)
    expect(r?.base.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('未登记符号对返回 null（两符号任一未登记即不可解析）', () => {
    // 注：DOGE/ETH 这类「两符号都在册」的组合按既有口径可解析（getPairTokens
    // 同口径），这里用完全未登记的符号验证 null 路径。
    expect(resolveSeedPair(SEPOLIA, 'XXX/YYY')).toBeNull()
    expect(resolvePair(SEPOLIA, 'XXX/YYY')).toBeNull()
    expect(resolveSeedPair(SEPOLIA, 'ETH/XXX')).toBeNull()
  })
})

describe('decimals 换算（docs/round60 §2）', () => {
  const resolved: ResolvedPair = {
    pair: KEY,
    displayPair: 'TKX6/USDT',
    base: { address: BASE_ADDR, symbol: 'TKX6', name: 'TKX Six', decimals: 6 },
    quote: { address: QUOTE_ADDR, symbol: 'USDT', name: 'Tether', decimals: 18 },
    source: 'listed',
  }

  it('价格缩放 = 18 + quote 位数 − base 位数 = 30', () => {
    expect(priceDecimalsFor(resolved.base, resolved.quote)).toBe(30)
  })

  it('人类价 2 → 原始 price = 2e30；数量 100（6 位）→ 100000000', () => {
    expect(humanPriceToRaw('2', resolved)).toBe('2' + '0'.repeat(30))
    expect(humanAmountToRaw('100', resolved)).toBe('100000000')
  })

  it('原始值反解回人类单位（往返）', () => {
    expect(rawPriceToHuman('2' + '0'.repeat(30), resolved)).toBe(2)
    expect(rawAmountToHuman('100000000', resolved)).toBe(100)
    expect(rawToPlain('100000000', 6)).toBe('100')
    expect(rawToPlain('2' + '0'.repeat(30), 30)).toBe('2')
  })

  it('种子对（18/18）缩放退化为现行口径：价格 60000 → 60000e18', () => {
    const seed = resolveSeedPair(SEPOLIA, 'BTC/USDT')!
    expect(priceDecimalsFor(seed.base, seed.quote)).toBe(18)
    expect(humanPriceToRaw('60000', seed)).toBe('60000' + '0'.repeat(18))
    expect(humanAmountToRaw('1.5', seed)).toBe('15' + '0'.repeat(17))
  })

  it('反向小数位（18 位 base × 6 位 quote）：价格缩放 = 6', () => {
    const inv: ResolvedPair = {
      ...resolved,
      base: { ...resolved.base, decimals: 18 },
      quote: { ...resolved.quote, decimals: 6 },
    }
    expect(priceDecimalsFor(inv.base, inv.quote)).toBe(6)
    expect(humanPriceToRaw('0.5', inv)).toBe('500000')
  })
})

describe('符号严检（与中继同口径）', () => {
  it('含分隔符/空白的符号被拒', () => {
    expect(validateTokenSymbol('TK X')).toBeNull()
    expect(validateTokenSymbol('TK/X')).toBeNull()
    expect(validateTokenSymbol('TK:X')).toBeNull()
    expect(validateTokenSymbol('  ')).toBeNull()
    expect(validateTokenSymbol('TKX6')).toBe('TKX6')
  })
})

describe('注册表客户端', () => {
  const rowJson = {
    chainId: SEPOLIA,
    pairKey: KEY,
    baseToken: BASE_ADDR,
    quoteToken: QUOTE_ADDR,
    baseSymbol: 'TKX6',
    quoteSymbol: 'USDT',
    baseName: 'TKX Six',
    quoteName: 'Tether',
    baseDecimals: 6,
    quoteDecimals: 18,
    creator: null,
    createdAt: 1700000000,
  }

  it('拉取解析并缓存（第二次走缓存不再发请求）', async () => {
    const FRESH_CHAIN = 424242
    const freshRow = {
      ...rowJson,
      chainId: FRESH_CHAIN,
      pairKey: buildPairKey(FRESH_CHAIN, BASE_ADDR, QUOTE_ADDR),
    }
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [freshRow],
    }))
    const rows = await fetchListedPairs(FRESH_CHAIN, { fetchFn: fetchFn as never })
    expect(rows).toHaveLength(1)
    expect(rows[0].base.symbol).toBe('TKX6')
    expect(rows[0].base.decimals).toBe(6)
    const again = await fetchListedPairs(FRESH_CHAIN, { fetchFn: fetchFn as never })
    expect(again).toHaveLength(1)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('拉取失败 → 返回空数组，不编造', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('network down')
    })
    const rows = await fetchListedPairs(434343, { fetchFn: fetchFn as never })
    expect(rows).toEqual([])
  })

  it('注册成功 → 并入缓存 → resolvePair 可解析（地址型键）', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ pair: rowJson, duplicate: false }),
    }))
    const { pair, duplicate } = await registerPairOnRelay(
      SEPOLIA,
      BASE_ADDR,
      QUOTE_ADDR,
      null,
      fetchFn as never,
    )
    expect(duplicate).toBe(false)
    expect(pair.base.decimals).toBe(6)
    const resolved = resolvePair(SEPOLIA, KEY)
    expect(resolved?.source).toBe('listed')
    expect(resolved?.displayPair).toBe('TKX6/USDT')
    expect(resolved?.base.decimals).toBe(6)
  })

  it('注册被中继拒收 → 抛带状态码的错误，不并入缓存', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => 'unknown pair',
      json: async () => ({}),
    }))
    await expect(
      registerPairOnRelay(SEPOLIA, BASE_ADDR, QUOTE_ADDR, null, fetchFn as never),
    ).rejects.toThrow(/400/)
  })
})
