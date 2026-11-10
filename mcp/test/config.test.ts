import { describe, expect, it } from 'vitest'
import {
  ALLOWED_PAIRS,
  assertAllowedChain,
  assertAllowedPair,
  chainSummary,
} from '../src/config'
import { ToolError } from '../src/errors'

describe('链白名单', () => {
  it('放行两条测试网', () => {
    expect(() => assertAllowedChain(11155111)).not.toThrow()
    expect(() => assertAllowedChain(84532)).not.toThrow()
  })
  it('拒绝主网与任意其他链', () => {
    for (const id of [1, 8453, 56, 1001, 137, 0, -1]) {
      try {
        assertAllowedChain(id)
        expect.unreachable(`chainId ${id} 应被拒绝`)
      } catch (e) {
        expect(e).toBeInstanceOf(ToolError)
        expect((e as ToolError).code).toBe('chain_not_allowed')
      }
    }
  })
})

describe('交易对白名单', () => {
  it('恰为现行 8 个测试交易对', () => {
    expect(ALLOWED_PAIRS).toHaveLength(8)
    expect(ALLOWED_PAIRS).toContain('TKA/TKB')
    expect(ALLOWED_PAIRS).toContain('BTC/USDT')
  })
  it('拒绝白名单外交易对', () => {
    expect(() => assertAllowedPair('DOGE/USDT')).not.toThrow()
    try {
      assertAllowedPair('PEPE/USDT')
      expect.unreachable()
    } catch (e) {
      expect((e as ToolError).code).toBe('pair_not_allowed')
    }
  })
})

describe('chainSummary 骑第 62 轮栈配置', () => {
  it('Sepolia 地址与第 62 轮栈一致', () => {
    const s = chainSummary(11155111)
    expect(s.settlement).toBe('0xa38c087778d76DA30654F30CB87D1ddD83f7b263')
    expect(s.vault).toBe('0x836cEFF0140aB66D8DD984ECb18765736BA121e9')
  })
  it('Base Sepolia 地址与第 62 轮栈一致（EIP-55 校验和形式）', () => {
    const s = chainSummary(84532)
    expect(s.settlement).toBe('0x4969b9ACBe7Dbf57E150FcF413B622c2912e2e97')
    expect(s.vault).toBe('0x295F5529F5BfA4cA39290f395b1feF7EA637f5D3')
  })
})
