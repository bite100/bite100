import { describe, it, expect } from 'vitest'
import {
  fromScaled,
  toPlain,
  priceDecimals,
  fmtPrice,
  fmtAmount,
  fmtTotal,
  fmtTime,
  fmtDateTime,
  fmtChartTime,
  sma,
} from './tradeFormat'

describe('fromScaled（节点定点 → 人类单位）', () => {
  it('BTC 价格定点字符串换算', () => {
    expect(fromScaled('75696050000000000000000.000000000000000000')).toBeCloseTo(75696.05, 6)
  })
  it('wei 数量换算', () => {
    expect(fromScaled('10000000000000000')).toBeCloseTo(0.01, 10)
    expect(fromScaled('1000000000000000000')).toBe(1)
  })
  it('非法输入返回 NaN', () => {
    expect(fromScaled('')).toBeNaN()
    expect(fromScaled(undefined)).toBeNaN()
    expect(fromScaled(null)).toBeNaN()
    expect(fromScaled('abc')).toBeNaN()
  })
  it('数字输入同样换算', () => {
    expect(fromScaled(2e18)).toBe(2)
  })
})

describe('toPlain', () => {
  it('修剪浮点尾巴且不用科学计数法', () => {
    expect(toPlain(75696.05)).toBe('75696.05')
    expect(toPlain(0.01)).toBe('0.01')
    expect(toPlain(1)).toBe('1')
    expect(toPlain(0.1 + 0.2)).toBe('0.3')
  })
})

describe('fmtPrice', () => {
  it('大价格 2 位小数 + 千分位', () => {
    expect(fmtPrice(75696.05)).toBe('75,696.05')
    expect(fmtPrice(2232.0694)).toBe('2,232.07')
  })
  it('单位价格 4 位', () => {
    expect(fmtPrice(1)).toBe('1.0000')
    expect(fmtPrice(12.34567)).toBe('12.3457')
  })
  it('小价格 6 位修剪、至少 4 位', () => {
    expect(fmtPrice(0.5)).toBe('0.5000')
    expect(fmtPrice(0.00007)).toBe('0.00007')
  })
  it('空值占位', () => {
    expect(fmtPrice(null)).toBe('—')
    expect(fmtPrice(NaN)).toBe('—')
  })
  it('priceDecimals 量级', () => {
    expect(priceDecimals(100)).toBe(2)
    expect(priceDecimals(99.9)).toBe(4)
    expect(priceDecimals(0.99)).toBe(6)
  })
})

describe('fmtAmount / fmtTotal', () => {
  it('数量修剪尾零、至少 2 位', () => {
    expect(fmtAmount(0.01)).toBe('0.01')
    expect(fmtAmount(1)).toBe('1.00')
    expect(fmtAmount(0.00007)).toBe('0.00007')
    expect(fmtAmount(44.31)).toBe('44.31')
    expect(fmtAmount(1259.05)).toBe('1,259.05')
    expect(fmtAmount(0)).toBe('0')
  })
  it('累计 ≥10000 用 K/M 缩写', () => {
    expect(fmtTotal(45220)).toBe('45.22K')
    expect(fmtTotal(1480000)).toBe('1.48M')
    expect(fmtTotal(9999)).toBe('9,999.00')
    expect(fmtTotal(5.299502)).toBe('5.2995')
  })
})

describe('时间（JST 显式）', () => {
  // 1794073792 = 2026-11-07T17:49:52Z = 2026-11-08 02:49:52 JST
  const ts = 1794073792
  it('fmtTime', () => {
    expect(fmtTime(ts)).toBe('02:49:52')
  })
  it('fmtDateTime', () => {
    expect(fmtDateTime(ts)).toBe('2026-11-08 02:49:52')
  })
  it('fmtChartTime', () => {
    expect(fmtChartTime(ts)).toBe('11-08 02:49')
  })
  it('0 值占位', () => {
    expect(fmtTime(0)).toBe('—')
    expect(fmtDateTime(0)).toBe('—')
  })
})

describe('sma', () => {
  it('周期内均值、不足周期为 null', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4])
  })
  it('数据短于周期全 null', () => {
    expect(sma([1, 2], 7)).toEqual([null, null])
  })
})
