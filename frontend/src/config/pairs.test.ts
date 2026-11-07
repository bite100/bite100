/**
 * 交易对登记单元测试（第二十五轮）：
 * - 8 个交易对与默认对 BTC/USDT；
 * - ?pair= 解析（合法/非法/缺失）；
 * - 两链每对的代币地址与链上部署一致（地址逐个取自部署脚本输出并经 cast 实读核对，
 *   见 docs/round25-mainstream-pairs-2026-11-07.md §1；改动部署地址必须同步改这里）。
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PAIR,
  TRADE_PAIRS,
  getPairTokens,
  isTradePair,
  pairFromSearch,
} from './pairs'

const SEPOLIA = 11155111
const BASE_SEPOLIA = 84532

describe('TRADE_PAIRS', () => {
  it('共 8 个交易对：7 个主流币对 USDT + TKA/TKB，默认 BTC/USDT', () => {
    expect([...TRADE_PAIRS]).toEqual([
      'BTC/USDT',
      'ETH/USDT',
      'SOL/USDT',
      'BNB/USDT',
      'XRP/USDT',
      'DOGE/USDT',
      'LINK/USDT',
      'TKA/TKB',
    ])
    expect(DEFAULT_PAIR).toBe('BTC/USDT')
  })
})

describe('isTradePair / pairFromSearch', () => {
  it('只认登记的交易对', () => {
    expect(isTradePair('BTC/USDT')).toBe(true)
    expect(isTradePair('TKA/TKB')).toBe(true)
    expect(isTradePair('ETH/USD')).toBe(false)
    expect(isTradePair('btc/usdt')).toBe(false)
    expect(isTradePair('')).toBe(false)
  })

  it('?pair= 合法时取该对', () => {
    expect(pairFromSearch('?pair=ETH/USDT')).toBe('ETH/USDT')
    expect(pairFromSearch('?pair=TKA/TKB')).toBe('TKA/TKB')
  })

  it('?pair= 缺失或非法时回默认对，不抛错', () => {
    expect(pairFromSearch('')).toBe('BTC/USDT')
    expect(pairFromSearch('?pair=ETH/USD')).toBe('BTC/USDT')
    expect(pairFromSearch('?pair=')).toBe('BTC/USDT')
    expect(pairFromSearch('?foo=bar')).toBe('BTC/USDT')
  })
})

describe('getPairTokens', () => {
  it('Sepolia 每对的代币地址与部署一致', () => {
    expect(getPairTokens(SEPOLIA, 'BTC/USDT')).toEqual({
      base: '0x8EDa0025C245B10eA1E10c257674B794C85350f3',
      quote: '0x6Ca8cb68Ee5BB15474f1cfFE07B895C974Ab9c6e',
    })
    expect(getPairTokens(SEPOLIA, 'ETH/USDT')).toEqual({
      base: '0x6851ec177dB923ae0A97F262351437D12B21710A',
      quote: '0x6Ca8cb68Ee5BB15474f1cfFE07B895C974Ab9c6e',
    })
    expect(getPairTokens(SEPOLIA, 'SOL/USDT')).toEqual({
      base: '0x42f7B1B6c2caFb1F3d930B0C247a08f608b034aa',
      quote: '0x6Ca8cb68Ee5BB15474f1cfFE07B895C974Ab9c6e',
    })
    expect(getPairTokens(SEPOLIA, 'BNB/USDT')).toEqual({
      base: '0x5657f5DBb2C49DBCd4F6d16ebbCb3D4870aACd29',
      quote: '0x6Ca8cb68Ee5BB15474f1cfFE07B895C974Ab9c6e',
    })
    expect(getPairTokens(SEPOLIA, 'XRP/USDT')).toEqual({
      base: '0x20191571978478AEea15BC39b7D5609BE343D88e',
      quote: '0x6Ca8cb68Ee5BB15474f1cfFE07B895C974Ab9c6e',
    })
    expect(getPairTokens(SEPOLIA, 'DOGE/USDT')).toEqual({
      base: '0xAb2D18f97E2dd39450bf1C0E59BC4d2Fb23212C7',
      quote: '0x6Ca8cb68Ee5BB15474f1cfFE07B895C974Ab9c6e',
    })
    expect(getPairTokens(SEPOLIA, 'LINK/USDT')).toEqual({
      base: '0x74159771935E66Ed7dC13370f2BCe89EC8292b18',
      quote: '0x6Ca8cb68Ee5BB15474f1cfFE07B895C974Ab9c6e',
    })
    expect(getPairTokens(SEPOLIA, 'TKA/TKB')).toEqual({
      base: '0x93a4af54d7cD8aF7c9aEF50D3Dd3977bA1Dde28E',
      quote: '0x1530b74E6d5C2D0e2b78314b5C253E66bfC4ddc2',
    })
  })

  it('Base Sepolia 每对的代币地址与部署一致', () => {
    expect(getPairTokens(BASE_SEPOLIA, 'BTC/USDT')).toEqual({
      base: '0xf1a6d8fd31fe9e72664fb9f07ffab8056a84156f',
      quote: '0xaab464e0be805c199007e27d8f651038319207d6',
    })
    expect(getPairTokens(BASE_SEPOLIA, 'ETH/USDT')).toEqual({
      base: '0x151c6be0d525880626f4757d58cd141872af7914',
      quote: '0xaab464e0be805c199007e27d8f651038319207d6',
    })
    expect(getPairTokens(BASE_SEPOLIA, 'SOL/USDT')).toEqual({
      base: '0xcb704487d52ccf66cae7680c348966e15fa0e430',
      quote: '0xaab464e0be805c199007e27d8f651038319207d6',
    })
    expect(getPairTokens(BASE_SEPOLIA, 'BNB/USDT')).toEqual({
      base: '0xf567c000f53c76e14fa21c4b90efecc0e4d586ec',
      quote: '0xaab464e0be805c199007e27d8f651038319207d6',
    })
    expect(getPairTokens(BASE_SEPOLIA, 'XRP/USDT')).toEqual({
      base: '0x26b58d2528a7fdfe744da338c5605123ea2266f3',
      quote: '0xaab464e0be805c199007e27d8f651038319207d6',
    })
    expect(getPairTokens(BASE_SEPOLIA, 'DOGE/USDT')).toEqual({
      base: '0x68bf313360021dcf4e359ad18c4506f622a3666d',
      quote: '0xaab464e0be805c199007e27d8f651038319207d6',
    })
    expect(getPairTokens(BASE_SEPOLIA, 'LINK/USDT')).toEqual({
      base: '0x43dc5f7099d3689d0dc73dbdc1e73e7a47e636e2',
      quote: '0xaab464e0be805c199007e27d8f651038319207d6',
    })
    expect(getPairTokens(BASE_SEPOLIA, 'TKA/TKB')).toEqual({
      base: '0xd3f1136Cb3511b4546BDE5dDAC4F0D5a4D5C5D33',
      quote: '0x8492ccCE958803F04772C0f5B51DbbC320A54daF',
    })
  })

  it('未登记的交易对/未知链返回 null，不编造地址', () => {
    expect(getPairTokens(SEPOLIA, 'ETH/USD')).toBeNull()
    expect(getPairTokens(SEPOLIA, 'DOGE/USDC')).toBeNull()
    expect(getPairTokens(1, 'BTC/USDT')).toBeNull()
    expect(getPairTokens(999, 'BTC/USDT')).toBeNull()
  })
})
