/**
 * 参考价层单元测试（第二十三轮）：
 * - 喂价配置落点（两链 ETH/USD 地址与心跳；TKA/TKB 无喂价；主网未配不伪造）
 * - 时效校验（过期拒绝、边界、心跳推导阈值）
 * - 数据有效性（零/负价、updatedAt 缺失拒绝）
 * - 偏离警告触发/不触发（含恰好 10% 边界）
 * - 来源优先级（预言机 > 本所最近成交 > 盘口中间价 > 无；过期不降级冒充）
 */
import { describe, it, expect, vi } from 'vitest'
import {
  DEVIATION_WARN_PCT,
  bookMidPrice,
  deviationPct,
  evaluateFeedReading,
  getFeedConfig,
  isDeviationWarning,
  resolveMarketReference,
  resolveReferencePrice,
  staleAfterSec,
  type FeedReading,
  type ReferencePriceDeps,
} from './referencePrice'

const NOW = 1_794_056_000
const SEPOLIA = 11155111
const BASE_SEPOLIA = 84532

describe('getFeedConfig', () => {
  it('Sepolia ETH/USD 指向官方喂价地址，心跳 3600s', () => {
    expect(getFeedConfig(SEPOLIA, 'ETH/USD')).toEqual({
      address: '0x694AA1769357215DE4FAC081bf1f309aDC325306',
      heartbeatSec: 3600,
    })
  })

  it('Base Sepolia ETH/USD 指向官方喂价地址，心跳 1200s', () => {
    expect(getFeedConfig(BASE_SEPOLIA, 'ETH/USD')).toEqual({
      address: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1',
      heartbeatSec: 1200,
    })
  })

  it('TKA/TKB 在两条链上都没有喂价（测试代币无外部报价，禁止映射）', () => {
    expect(getFeedConfig(SEPOLIA, 'TKA/TKB')).toBeNull()
    expect(getFeedConfig(BASE_SEPOLIA, 'TKA/TKB')).toBeNull()
  })

  it('第二十五轮：Sepolia BTC/USDT 用 BTC/USD 官方喂价，心跳 3600s（实测轮次间隔约 3624s）', () => {
    expect(getFeedConfig(SEPOLIA, 'BTC/USDT')).toEqual({
      address: '0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43',
      heartbeatSec: 3600,
    })
  })

  it('第二十五轮：ETH/USDT 两链复用 ETH/USD 官方喂价（美元计价，USDT 约等于 1 美元）', () => {
    expect(getFeedConfig(SEPOLIA, 'ETH/USDT')).toEqual({
      address: '0x694AA1769357215DE4FAC081bf1f309aDC325306',
      heartbeatSec: 3600,
    })
    expect(getFeedConfig(BASE_SEPOLIA, 'ETH/USDT')).toEqual({
      address: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1',
      heartbeatSec: 1200,
    })
  })

  it('第二十五轮：未找到已核实喂价的对不配——SOL/BNB/XRP/DOGE/LINK/USDT 两链皆无，Base Sepolia BTC/USDT 亦无', () => {
    for (const pair of ['SOL/USDT', 'BNB/USDT', 'XRP/USDT', 'DOGE/USDT', 'LINK/USDT']) {
      expect(getFeedConfig(SEPOLIA, pair)).toBeNull()
      expect(getFeedConfig(BASE_SEPOLIA, pair)).toBeNull()
    }
    expect(getFeedConfig(BASE_SEPOLIA, 'BTC/USDT')).toBeNull()
  })

  it('主网尚未配置喂价、未知链返回 null', () => {
    expect(getFeedConfig(1, 'ETH/USD')).toBeNull()
    expect(getFeedConfig(999, 'ETH/USD')).toBeNull()
  })
})

describe('staleAfterSec', () => {
  it('阈值 = 心跳 × 3', () => {
    expect(staleAfterSec(3600)).toBe(10800)
    expect(staleAfterSec(86400)).toBe(259200)
  })

  it('短心跳有 1 小时下限（Base Sepolia 1200s → 3600s）', () => {
    expect(staleAfterSec(1200)).toBe(3600)
  })

  it('非法心跳回退到下限', () => {
    expect(staleAfterSec(0)).toBe(3600)
    expect(staleAfterSec(NaN)).toBe(3600)
  })
})

describe('evaluateFeedReading', () => {
  const fresh: FeedReading = { answer: 224202584969n, decimals: 8, updatedAtSec: NOW - 1786 }

  it('新鲜读数换算为人类单位价格（2026-11-07 Sepolia 实读值）', () => {
    const ev = evaluateFeedReading(fresh, NOW, 3600)
    expect(ev.kind).toBe('ok')
    if (ev.kind === 'ok') expect(ev.price).toBeCloseTo(2242.02584969, 8)
  })

  it('超过时效阈值判 stale（Sepolia：年龄 10801s > 3×3600s）', () => {
    const ev = evaluateFeedReading({ ...fresh, updatedAtSec: NOW - 10801 }, NOW, 3600)
    expect(ev).toEqual({ kind: 'stale', updatedAtSec: NOW - 10801 })
  })

  it('恰好等于阈值不判 stale（严格大于才过期）', () => {
    const ev = evaluateFeedReading({ ...fresh, updatedAtSec: NOW - 10800 }, NOW, 3600)
    expect(ev.kind).toBe('ok')
  })

  it('Base Sepolia 心跳 1200s：年龄 3600s 可用、3601s 过期', () => {
    expect(evaluateFeedReading({ ...fresh, updatedAtSec: NOW - 3600 }, NOW, 1200).kind).toBe('ok')
    expect(evaluateFeedReading({ ...fresh, updatedAtSec: NOW - 3601 }, NOW, 1200).kind).toBe('stale')
  })

  it('零价/负价拒绝', () => {
    expect(evaluateFeedReading({ ...fresh, answer: 0n }, NOW, 3600).kind).toBe('invalid')
    expect(evaluateFeedReading({ ...fresh, answer: -5n }, NOW, 3600).kind).toBe('invalid')
  })

  it('updatedAt 缺失（0）拒绝', () => {
    expect(evaluateFeedReading({ ...fresh, updatedAtSec: 0 }, NOW, 3600).kind).toBe('invalid')
  })

  it('updatedAt 晚于本地时间（时钟偏差）不误杀', () => {
    const ev = evaluateFeedReading({ ...fresh, updatedAtSec: NOW + 600 }, NOW, 3600)
    expect(ev.kind).toBe('ok')
  })
})

describe('bookMidPrice', () => {
  it('双边盘口取 (最高买 + 最低卖) / 2，顺序无关', () => {
    const mid = bookMidPrice(
      [
        { price: '1.5', amount: '10' },
        { price: '2.0', amount: '5' },
      ],
      [
        { price: '3.0', amount: '5' },
        { price: '2.6', amount: '10' },
      ]
    )
    expect(mid).toBeCloseTo(2.3)
  })

  it('单边或空盘口返回 null', () => {
    expect(bookMidPrice([{ price: '2.0', amount: '5' }], [])).toBeNull()
    expect(bookMidPrice([], [{ price: '2.6', amount: '5' }])).toBeNull()
    expect(bookMidPrice(undefined, undefined)).toBeNull()
  })

  it('非法价格档位被过滤', () => {
    expect(
      bookMidPrice(
        [{ price: '0', amount: '5' }],
        [{ price: 'abc', amount: '5' }]
      )
    ).toBeNull()
  })
})

describe('deviationPct / isDeviationWarning', () => {
  it('阈值常量为 10%', () => {
    expect(DEVIATION_WARN_PCT).toBe(10)
  })

  it('偏离带符号：高于为正、低于为负', () => {
    expect(deviationPct(110, 100)).toBeCloseTo(10)
    expect(deviationPct(90, 100)).toBeCloseTo(-10)
  })

  it('恰好 10% 不触发（严格超过才警告）', () => {
    expect(isDeviationWarning(110, 100)).toBe(false)
    expect(isDeviationWarning(90, 100)).toBe(false)
  })

  it('超过 10% 触发：+11% 与 −11% 都触发', () => {
    expect(isDeviationWarning(111, 100)).toBe(true)
    expect(isDeviationWarning(89, 100)).toBe(true)
  })

  it('小偏离不触发', () => {
    expect(isDeviationWarning(105, 100)).toBe(false)
    expect(isDeviationWarning(100, 100)).toBe(false)
  })

  it('无效价格不触发', () => {
    expect(isDeviationWarning(0, 100)).toBe(false)
    expect(isDeviationWarning(100, 0)).toBe(false)
    expect(isDeviationWarning(NaN, 100)).toBe(false)
    expect(deviationPct(100, 0)).toBeNull()
  })
})

describe('resolveMarketReference（无喂价对的兜底）', () => {
  it('有最近成交 → 本所最近成交价，带成交时间', () => {
    const res = resolveMarketReference(
      { lastTradePrice: 1.25, lastTradeAtSec: NOW - 60, bids: [], asks: [] },
      NOW
    )
    expect(res).toEqual({
      status: 'ok',
      ref: { price: 1.25, source: 'lastTrade', updatedAtSec: NOW - 60 },
    })
  })

  it('无成交有双边盘口 → 盘口中间价', () => {
    const res = resolveMarketReference(
      {
        lastTradePrice: null,
        lastTradeAtSec: null,
        bids: [{ price: '2.0', amount: '5' }],
        asks: [{ price: '2.6', amount: '5' }],
      },
      NOW
    )
    expect(res.status).toBe('ok')
    if (res.status === 'ok') {
      expect(res.ref.source).toBe('bookMid')
      expect(res.ref.price).toBeCloseTo(2.3)
    }
  })

  it('TKA/TKB 冷启动：无成交、单边盘口 → none（暂无参考价，不编造）', () => {
    const res = resolveMarketReference(
      {
        lastTradePrice: null,
        lastTradeAtSec: null,
        bids: [{ price: '2.0', amount: '5' }],
        asks: [],
      },
      NOW
    )
    expect(res).toEqual({ status: 'none' })
  })

  it('完全无数据 → none', () => {
    expect(
      resolveMarketReference({ lastTradePrice: null, lastTradeAtSec: null }, NOW)
    ).toEqual({ status: 'none' })
  })
})

describe('resolveReferencePrice（总入口）', () => {
  const freshReading: FeedReading = {
    answer: 224202584969n,
    decimals: 8,
    updatedAtSec: NOW - 100,
  }
  const deps = (readFeed: ReferencePriceDeps['readFeed']): ReferencePriceDeps => ({
    readFeed,
    nowSec: () => NOW,
  })
  const noMarket = { lastTradePrice: null, lastTradeAtSec: null }

  it('有喂价且新鲜：预言机优先，哪怕同时存在本所成交价', async () => {
    const res = await resolveReferencePrice(
      SEPOLIA,
      'ETH/USD',
      { lastTradePrice: 999, lastTradeAtSec: NOW - 10 },
      deps(vi.fn(async () => freshReading))
    )
    expect(res.status).toBe('ok')
    if (res.status === 'ok') {
      expect(res.ref.source).toBe('chainlink')
      expect(res.ref.price).toBeCloseTo(2242.02584969, 8)
      expect(res.ref.updatedAtSec).toBe(NOW - 100)
    }
  })

  it('有喂价但过期：判 stale，不降级用本所成交价冒充', async () => {
    const stale: FeedReading = { ...freshReading, updatedAtSec: NOW - 20000 }
    const res = await resolveReferencePrice(
      SEPOLIA,
      'ETH/USD',
      { lastTradePrice: 999, lastTradeAtSec: NOW - 10 },
      deps(vi.fn(async () => stale))
    )
    expect(res).toEqual({ status: 'stale', updatedAtSec: NOW - 20000 })
  })

  it('喂价读取抛错 → error', async () => {
    const res = await resolveReferencePrice(
      BASE_SEPOLIA,
      'ETH/USD',
      noMarket,
      deps(
        vi.fn(async () => {
          throw new Error('RPC down')
        })
      )
    )
    expect(res).toEqual({ status: 'error' })
  })

  it('喂价返回零价 → error（非法数据不当参考价）', async () => {
    const res = await resolveReferencePrice(
      SEPOLIA,
      'ETH/USD',
      noMarket,
      deps(vi.fn(async () => ({ ...freshReading, answer: 0n })))
    )
    expect(res).toEqual({ status: 'error' })
  })

  it('无喂价对（TKA/TKB）不读预言机，走本所成交价兜底', async () => {
    const readFeed = vi.fn(async () => freshReading)
    const res = await resolveReferencePrice(
      SEPOLIA,
      'TKA/TKB',
      { lastTradePrice: 1.5, lastTradeAtSec: NOW - 30 },
      deps(readFeed)
    )
    expect(readFeed).not.toHaveBeenCalled()
    expect(res.status).toBe('ok')
    if (res.status === 'ok') expect(res.ref.source).toBe('lastTrade')
  })

  it('无喂价且无市场数据 → none', async () => {
    const res = await resolveReferencePrice(
      BASE_SEPOLIA,
      'TKA/TKB',
      noMarket,
      deps(vi.fn(async () => freshReading))
    )
    expect(res).toEqual({ status: 'none' })
  })
})
