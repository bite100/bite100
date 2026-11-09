import { describe, it, expect } from 'vitest'
import { valueTokens, changeVs24h, recordSnapshot, type TokenBalance } from './valuation'

const bal = (patch: Partial<TokenBalance>): TokenBalance => ({
  symbol: 'USDT',
  wallet: 0,
  vaultTotal: 0,
  vaultAvailable: 0,
  vaultLocked: 0,
  ...patch,
})

describe('valueTokens', () => {
  it('values only priced tokens and lists unpriced holdings for disclosure', () => {
    const prices = new Map([
      ['USDT', 1],
      ['ETH', 3000],
    ])
    const res = valueTokens(
      [
        bal({ symbol: 'USDT', wallet: 100, vaultTotal: 50 }),
        bal({ symbol: 'ETH', wallet: 0.5 }),
        bal({ symbol: 'TKA', wallet: 9999 }),
        bal({ symbol: 'BTC', wallet: 0 }),
      ],
      prices,
    )
    expect(res.totalValue).toBe(150 + 1500)
    expect(res.unpricedHeld).toEqual(['TKA'])
    expect(res.rows.find((r) => r.symbol === 'TKA')?.valueUsd).toBeNull()
    expect(res.distribution.map((d) => d.symbol)).toEqual(['ETH', 'USDT'])
    expect(res.distribution[0].pct).toBeCloseTo((1500 / 1650) * 100)
  })
})

describe('valuation snapshots', () => {
  it('records with gap throttling and pruning', () => {
    const store = new Map<string, string>()
    const storage = { setItem: (k: string, v: string) => void store.set(k, v), getItem: (k: string) => store.get(k) ?? null }
    let snaps = recordSnapshot([], 100, 1_000_000, storage)
    expect(snaps).toHaveLength(1)
    snaps = recordSnapshot(snaps, 100, 1_000_000 + 60_000, storage) // 同值且间隔小 → 不重复记
    expect(snaps).toHaveLength(1)
    snaps = recordSnapshot(snaps, 101, 1_000_000 + 120_000, storage) // 值变化 → 记录
    expect(snaps).toHaveLength(2)
  })

  it('changeVs24h needs a >=23h old snapshot and computes pct', () => {
    const now = 100 * 3600 * 1000
    expect(changeVs24h([{ t: now - 3600 * 1000, total: 100 }], 110, now)).toBeNull()
    const ch = changeVs24h(
      [
        { t: now - 25 * 3600 * 1000, total: 100 },
        { t: now - 3600 * 1000, total: 105 },
      ],
      110,
      now,
    )
    expect(ch?.pct).toBeCloseTo(10)
    expect(ch?.spark[ch!.spark.length - 1].v).toBe(110)
    expect(ch?.spark[ch!.spark.length - 1].t).toBe(now)
  })
})

