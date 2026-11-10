/**
 * 第 63 轮 gas-2：gas库索引纯逻辑单测。
 * 覆盖 src/lib/gasvault.ts 的五类事件 → GasVaultFlow 字段映射与实体 ID 口径。
 * TestIndexer 合成事件测试需 config.yaml 的链绑定（地址+起始块），GasVault
 * 部署属部署步——绑定落地后在 testindexer 侧补合成用例（部署步清单已列）。
 */
import { describe, it, expect } from 'vitest'
import {
  gasVaultEntityId,
  depositFlow,
  withdrawFlow,
  conversionFlow,
  shortfallFlow,
  floatFundedFlow,
} from '../src/lib/gasvault'

const A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const T = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'
const CLAIM = `0x${'AB'.repeat(32)}`

describe('gasVaultEntityId', () => {
  it('chainId-txHash(小写)-logIndex，与 Trade 同口径', () => {
    expect(gasVaultEntityId(11155111, `0x${'CD'.repeat(32)}`, 7)).toBe(
      `11155111-0x${'cd'.repeat(32)}-7`
    )
  })
})

describe('五类事件字段映射', () => {
  it('deposit：actor=sender、counterparty=owner、amount=assets、secondary=shares、地址小写', () => {
    const f = depositFlow({ sender: A, owner: B, assets: 100n, shares: 99n })
    expect(f).toEqual({
      kind: 'deposit',
      actor: A.toLowerCase(),
      counterparty: B.toLowerCase(),
      token: undefined,
      amount: 100n,
      secondaryAmount: 99n,
      claimId: undefined,
    })
  })

  it('withdraw：actor=sender、counterparty=receiver', () => {
    const f = withdrawFlow({ sender: A, receiver: B, assets: 50n, shares: 51n })
    expect(f.kind).toBe('withdraw')
    expect(f.actor).toBe(A.toLowerCase())
    expect(f.counterparty).toBe(B.toLowerCase())
    expect(f.amount).toBe(50n)
    expect(f.secondaryAmount).toBe(51n)
  })

  it('conversion：token=换出币、amount=换出量、secondary=换回包装原生币量、无 counterparty', () => {
    const f = conversionFlow({ caller: A, tokenIn: T, amountIn: 10n, assetReceived: 19n })
    expect(f.kind).toBe('conversion')
    expect(f.actor).toBe(A.toLowerCase())
    expect(f.token).toBe(T.toLowerCase())
    expect(f.amount).toBe(10n)
    expect(f.secondaryAmount).toBe(19n)
    expect(f.counterparty).toBeUndefined()
  })

  it('shortfall：actor=受益人、counterparty=计量人、claimId 小写落库', () => {
    const f = shortfallFlow({ claimId: CLAIM, beneficiary: A, amount: 3n, measurer: B })
    expect(f.kind).toBe('shortfall')
    expect(f.actor).toBe(A.toLowerCase())
    expect(f.counterparty).toBe(B.toLowerCase())
    expect(f.claimId).toBe(CLAIM.toLowerCase())
    expect(f.amount).toBe(3n)
  })

  it('float-funded：actor=注资人、amount=注资额', () => {
    const f = floatFundedFlow({ from: A, amount: 7n })
    expect(f.kind).toBe('float-funded')
    expect(f.actor).toBe(A.toLowerCase())
    expect(f.amount).toBe(7n)
    expect(f.secondaryAmount).toBeUndefined()
  })
})
