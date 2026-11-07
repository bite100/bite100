/**
 * 下单时一键补存差额测试（第十七轮 Part D）：义务/差额计算与流程状态机
 */
import { describe, it, expect, vi } from 'vitest'
import {
  orderObligationWei,
  shortfallWei,
  ensureVaultBalance,
  VaultTopUpError,
  type VaultTopUpDeps,
} from './vaultTopUp'

const E18 = 1000000000000000000n

describe('orderObligationWei', () => {
  it('卖单义务 = amountIn（卖出币）', () => {
    expect(orderObligationWei('sell', 100n * E18, 2n * E18)).toBe(100n * E18)
  })
  it('买单义务 = amountIn × 价格（买入币）', () => {
    expect(orderObligationWei('buy', 100n * E18, 2n * E18)).toBe(200n * E18)
    expect(orderObligationWei('buy', 80n * E18, 22n * E18 / 10n)).toBe(176n * E18)
  })
})

describe('shortfallWei', () => {
  it('不足时为差额，充足为 0', () => {
    expect(shortfallWei(200n, 150n)).toBe(50n)
    expect(shortfallWei(200n, 200n)).toBe(0n)
    expect(shortfallWei(200n, 260n)).toBe(0n)
  })
})

function makeDeps(overrides: Partial<VaultTopUpDeps> = {}): VaultTopUpDeps {
  return {
    allowance: vi.fn(async () => 0n),
    approve: vi.fn(async () => {}),
    deposit: vi.fn(async () => {}),
    available: vi.fn(async () => 200n * E18),
    ...overrides,
  }
}

describe('ensureVaultBalance', () => {
  it('可用额充足：不触发任何链上操作', async () => {
    const deps = makeDeps()
    const r = await ensureVaultBalance({
      requiredWei: 100n * E18,
      availableWei: 150n * E18,
      walletWei: 0n,
      deps,
    })
    expect(r.toppedUp).toBe(false)
    expect(deps.allowance).not.toHaveBeenCalled()
    expect(deps.approve).not.toHaveBeenCalled()
    expect(deps.deposit).not.toHaveBeenCalled()
  })

  it('不足且授权不足：授权差额 → 存入差额 → 回读确认，步骤顺序正确', async () => {
    const deps = makeDeps()
    const steps: string[] = []
    const r = await ensureVaultBalance({
      requiredWei: 200n * E18,
      availableWei: 120n * E18,
      walletWei: 500n * E18,
      deps,
      onStep: (s) => steps.push(s),
    })
    expect(r.toppedUp).toBe(true)
    expect(r.shortfallWei).toBe(80n * E18)
    expect(deps.approve).toHaveBeenCalledWith(80n * E18)
    expect(deps.deposit).toHaveBeenCalledWith(80n * E18)
    expect(steps).toEqual(['approving', 'depositing', 'verifying'])
  })

  it('授权已足额：跳过授权直接存入', async () => {
    const deps = makeDeps({ allowance: vi.fn(async () => 1000n * E18) })
    const steps: string[] = []
    await ensureVaultBalance({
      requiredWei: 200n * E18,
      availableWei: 120n * E18,
      walletWei: 500n * E18,
      deps,
      onStep: (s) => steps.push(s),
    })
    expect(deps.approve).not.toHaveBeenCalled()
    expect(deps.deposit).toHaveBeenCalledWith(80n * E18)
    expect(steps).toEqual(['depositing', 'verifying'])
  })

  it('钱包余额不够补差额：抛 wallet-insufficient，不触发存入', async () => {
    const deps = makeDeps()
    await expect(
      ensureVaultBalance({
        requiredWei: 200n * E18,
        availableWei: 120n * E18,
        walletWei: 50n * E18,
        deps,
      })
    ).rejects.toMatchObject({ kind: 'wallet-insufficient' })
    expect(deps.deposit).not.toHaveBeenCalled()
  })

  it('用户在钱包拒绝存入：抛 topup-rejected，下单必须停在此步', async () => {
    const deps = makeDeps({
      deposit: vi.fn(async () => {
        throw new Error('user rejected transaction')
      }),
    })
    await expect(
      ensureVaultBalance({
        requiredWei: 200n * E18,
        availableWei: 120n * E18,
        walletWei: 500n * E18,
        deps,
      })
    ).rejects.toBeInstanceOf(VaultTopUpError)
    await expect(
      ensureVaultBalance({
        requiredWei: 200n * E18,
        availableWei: 120n * E18,
        walletWei: 500n * E18,
        deps,
      })
    ).rejects.toMatchObject({ kind: 'topup-rejected' })
  })

  it('存入交易失败（非拒绝）：抛 topup-failed', async () => {
    const deps = makeDeps({
      approve: vi.fn(async () => {
        throw new Error('network timeout')
      }),
    })
    await expect(
      ensureVaultBalance({
        requiredWei: 200n * E18,
        availableWei: 120n * E18,
        walletWei: 500n * E18,
        deps,
      })
    ).rejects.toMatchObject({ kind: 'topup-failed' })
    expect(deps.deposit).not.toHaveBeenCalled()
  })

  it('补存上链但回读仍不足：抛 still-insufficient', async () => {
    const deps = makeDeps({ available: vi.fn(async () => 150n * E18) })
    await expect(
      ensureVaultBalance({
        requiredWei: 200n * E18,
        availableWei: 120n * E18,
        walletWei: 500n * E18,
        deps,
      })
    ).rejects.toMatchObject({ kind: 'still-insufficient' })
  })
})
