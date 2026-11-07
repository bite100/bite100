import { describe, it, expect } from 'vitest'
import {
  filterMarketRows,
  sortMarketRows,
  toggleFavorite,
  fmtCompactAmount,
  type MarketRowData,
} from './marketsData'

const row = (patch: Partial<MarketRowData>): MarketRowData => ({
  pair: 'BTC/USDT',
  base: 'BTC',
  quote: 'USDT',
  lastPrice: 100,
  changePct: 1.5,
  volumeQuote: 1000,
  refUsd: 100,
  held: false,
  ...patch,
})

describe('toggleFavorite', () => {
  it('toggles membership without duplicating', () => {
    expect(toggleFavorite([], 'BTC/USDT')).toEqual(['BTC/USDT'])
    expect(toggleFavorite(['BTC/USDT'], 'BTC/USDT')).toEqual([])
    expect(toggleFavorite(['BTC/USDT'], 'ETH/USDT')).toEqual(['BTC/USDT', 'ETH/USDT'])
  })
})

describe('filterMarketRows', () => {
  const rows = [
    row({}),
    row({ pair: 'ETH/USDT', base: 'ETH', held: true }),
    row({ pair: 'TKA/TKB', base: 'TKA', quote: 'TKB' }),
  ]
  it('filters by favorites tab and held tab', () => {
    const favs = new Set(['TKA/TKB'])
    expect(filterMarketRows(rows, '', 'fav', favs).map((r) => r.pair)).toEqual(['TKA/TKB'])
    expect(filterMarketRows(rows, '', 'held', favs).map((r) => r.pair)).toEqual(['ETH/USDT'])
  })
  it('matches search against pair and symbols, case-insensitive', () => {
    const favs = new Set<string>()
    expect(filterMarketRows(rows, 'tkb', 'all', favs).map((r) => r.pair)).toEqual(['TKA/TKB'])
    expect(filterMarketRows(rows, 'eth', 'all', favs).map((r) => r.pair)).toEqual(['ETH/USDT'])
  })
})

describe('sortMarketRows', () => {
  const rows = [
    row({ pair: 'A/USDT', volumeQuote: 10, lastPrice: 5, changePct: -1 }),
    row({ pair: 'B/USDT', volumeQuote: 99, lastPrice: null, changePct: null }),
    row({ pair: 'C/USDT', volumeQuote: 50, lastPrice: 7, changePct: 3 }),
  ]
  it('sorts by volume desc with no-trade rows last', () => {
    expect(sortMarketRows(rows, 'volume', 'desc').map((r) => r.pair)).toEqual([
      'B/USDT',
      'C/USDT',
      'A/USDT',
    ])
    // volume 本身有值时按数值排；价格为 null 的行在按价格排序时沉底
    expect(sortMarketRows(rows, 'price', 'desc').map((r) => r.pair)).toEqual([
      'C/USDT',
      'A/USDT',
      'B/USDT',
    ])
    expect(sortMarketRows(rows, 'price', 'asc').map((r) => r.pair)).toEqual([
      'A/USDT',
      'C/USDT',
      'B/USDT',
    ])
  })
  it('sorts by change in both directions, nulls last', () => {
    expect(sortMarketRows(rows, 'change', 'desc').map((r) => r.pair)).toEqual([
      'C/USDT',
      'A/USDT',
      'B/USDT',
    ])
    expect(sortMarketRows(rows, 'change', 'asc').map((r) => r.pair)).toEqual([
      'A/USDT',
      'C/USDT',
      'B/USDT',
    ])
  })
})

describe('fmtCompactAmount', () => {
  it('formats K/M magnitudes', () => {
    expect(fmtCompactAmount(12_400_000)).toBe('12.4M')
    expect(fmtCompactAmount(345_600)).toBe('345.6K')
    expect(fmtCompactAmount(98.2)).toBe('98.20')
  })
})
