/**
 * 第 46 轮：链上硬撤单服务层测试。Vault 合约以结构假件注入，
 * signer 用 ethers.Wallet（Hardhat 测试账户 #0，与 dualread.test.ts
 * 同一夹具口径）；digest 重算走生产 dualread/digest。
 */
import { describe, it, expect, vi } from 'vitest'
import { ethers } from 'ethers'
import {
  hardCancelOrderOnChain,
  type VaultLockContractLike,
} from './hardCancel'
import { buildSignedOrderData, computeOrderDigest } from './dualread/digest'
import { getPairTokens } from '../config/pairs'
import type { RawOrder } from './dualread/types'

const CHAIN = 11155111
const PK0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const wallet = new ethers.Wallet(PK0)
const TOKENS = getPairTokens(CHAIN, 'BTC/USDT')!

const ORDER: RawOrder = {
  orderId: 'ord-r46-1',
  trader: wallet.address,
  pair: 'BTC/USDT',
  side: 'sell',
  price: (2000n * 10n ** 18n).toString(),
  amount: (100n * 10n ** 18n).toString(),
  filled: '0',
  status: 'open',
  nonce: 3,
  createdAt: 1762000000,
  expiresAt: 1762604800,
  signature: '0x' + '11'.repeat(65),
}

const MY_LOCK = {
  user: wallet.address,
  token: TOKENS.base,
  remaining: 100n * 10n ** 18n,
  expiresAt: 1762604800n,
}
const NO_LOCK = {
  user: ethers.ZeroAddress,
  token: ethers.ZeroAddress,
  remaining: 0n,
  expiresAt: 0n,
}

function fakeVault(script: {
  locks: unknown[]
  releaseTx?: { hash: string; status: number | null }
}) {
  const calls: string[] = []
  let i = 0
  const vault: VaultLockContractLike = {
    orderLocks: vi.fn(async () => {
      calls.push('orderLocks')
      return script.locks[Math.min(i++, script.locks.length - 1)] as never
    }),
    releaseOrderLock: vi.fn(async () => {
      calls.push('releaseOrderLock')
      const tx = script.releaseTx ?? { hash: '0xtxhash', status: 1 }
      return { hash: tx.hash, wait: async () => ({ status: tx.status }) }
    }),
  }
  return { vault, calls }
}

describe('hardCancelOrderOnChain（第 46 轮）', () => {
  it('锁不存在 → not-locked，不发交易', async () => {
    const { vault, calls } = fakeVault({ locks: [NO_LOCK] })
    const res = await hardCancelOrderOnChain({
      order: ORDER,
      chainId: CHAIN,
      signer: wallet,
      vault,
    })
    expect(res.status).toBe('not-locked')
    expect(calls).toEqual(['orderLocks'])
    // digest 与生产重算口径一致
    const data = buildSignedOrderData(ORDER, CHAIN)!
    expect(res.digest).toBe(computeOrderDigest(data, CHAIN))
  })

  it('锁属本人 → 发交易、等回执、回读消失才报 released', async () => {
    const { vault, calls } = fakeVault({ locks: [MY_LOCK, NO_LOCK] })
    const res = await hardCancelOrderOnChain({
      order: ORDER,
      chainId: CHAIN,
      signer: wallet,
      vault,
    })
    expect(res).toMatchObject({ status: 'released', txHash: '0xtxhash' })
    expect(calls).toEqual(['orderLocks', 'releaseOrderLock', 'orderLocks'])
  })

  it('锁属他人 → 抛错且不发交易', async () => {
    const other = {
      ...MY_LOCK,
      user: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    }
    const { vault, calls } = fakeVault({ locks: [other] })
    await expect(
      hardCancelOrderOnChain({ order: ORDER, chainId: CHAIN, signer: wallet, vault }),
    ).rejects.toThrow('不属于当前钱包')
    expect(calls).toEqual(['orderLocks'])
  })

  it('回执状态 0 → 抛错，不报成功', async () => {
    const { vault } = fakeVault({
      locks: [MY_LOCK, NO_LOCK],
      releaseTx: { hash: '0xdead', status: 0 },
    })
    await expect(
      hardCancelOrderOnChain({ order: ORDER, chainId: CHAIN, signer: wallet, vault }),
    ).rejects.toThrow('未成功')
  })

  it('回读锁仍在 → 抛错，不报成功', async () => {
    const { vault } = fakeVault({ locks: [MY_LOCK, MY_LOCK] })
    await expect(
      hardCancelOrderOnChain({ order: ORDER, chainId: CHAIN, signer: wallet, vault }),
    ).rejects.toThrow('回读确认锁仍存在')
  })

  it('订单不可重构（未知交易对）→ 抛错', async () => {
    const { vault } = fakeVault({ locks: [NO_LOCK] })
    await expect(
      hardCancelOrderOnChain({
        order: { ...ORDER, pair: 'XXX/YYY' },
        chainId: CHAIN,
        signer: wallet,
        vault,
      }),
    ).rejects.toThrow('无法重算链上订单摘要')
  })
})
