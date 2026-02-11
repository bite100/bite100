import { describe, it, expect } from 'vitest'
import { feePercentToBps, validateProposalFeePercent } from './governanceUtils'

describe('governanceUtils', () => {
  describe('feePercentToBps', () => {
    it('converts 0.08 to 8 bps', () => {
      expect(feePercentToBps('0.08')).toBe(8)
    })
    it('converts 1 to 100 bps', () => {
      expect(feePercentToBps('1')).toBe(100)
    })
    it('converts 0.01 to 1 bps', () => {
      expect(feePercentToBps('0.01')).toBe(1)
    })
    it('converts 100 to 10000 bps', () => {
      expect(feePercentToBps('100')).toBe(10000)
    })
    it('returns null for zero', () => {
      expect(feePercentToBps('0')).toBeNull()
    })
    it('returns null for negative', () => {
      expect(feePercentToBps('-0.5')).toBeNull()
    })
    it('returns null for over 100', () => {
      expect(feePercentToBps('101')).toBeNull()
    })
    it('returns null for invalid input', () => {
      expect(feePercentToBps('')).toBeNull()
      expect(feePercentToBps('abc')).toBeNull()
    })
  })

  describe('validateProposalFeePercent', () => {
    it('returns null for valid input', () => {
      expect(validateProposalFeePercent('0.08')).toBeNull()
      expect(validateProposalFeePercent('1')).toBeNull()
    })
    it('returns error for empty', () => {
      expect(validateProposalFeePercent('')).toBe('请输入手续费比例')
      expect(validateProposalFeePercent('   ')).toBe('请输入手续费比例')
    })
    it('returns error for invalid range', () => {
      expect(validateProposalFeePercent('0')).toBe('手续费比例需在 0.01～100 之间')
      expect(validateProposalFeePercent('101')).toBe('手续费比例需在 0.01～100 之间')
    })
  })
})
