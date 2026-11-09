/**
 * 第 46 轮：链上硬撤单服务层测试。Vault/Settlement 合约以结构假件注入，
 * signer 用 ethers.Wallet（Hardhat 测试账户 #0，与 dualread.test.ts
 * 同一夹具口径）；digest 重算走生产 dualread/digest。
 * 第 47 轮：对齐永久撤单（撤单墓碑）——无锁四态区分
 * （never-locked / already-cancelled / filled / expired-released）、
 * 释放后回读墓碑确认、旧栈无 cancelledOrders 读口时的降级口径。
 */
import { describe, it, expect, vi } from 'vitest'
import { ethers } from 'ethers'
import {
  hardCancelOrderOnChain,
  type SettlementFilledLike,
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
const NO_TOMB = { user: ethers.ZeroAddress, token: ethers.ZeroAddress }
const MY_TOMB = { user: wallet.address, token: TOKENS.base }

function fakeVault(script: {
  locks: unknown[]
  /** cancelledOrders 的逐次返回（Error 表示调用抛错，模拟旧栈无此读口） */
  cancelled?: (boolean | Error)[]
  tombstone?: { user: string; token: string }
  releaseTx?: { hash: string; status: number | null }
}) {
  const calls: string[] = []
  let i = 0
  let ci = 0
  const cancelledSeq = script.cancelled ?? [false]
  const vault: VaultLockContractLike = {
    orderLocks: vi.fn(async () => {
      calls.push('orderLocks')
      return script.locks[Math.min(i++, script.locks.length - 1)] as never
    }),
    lockTombstones: vi.fn(async () => {
      calls.push('lockTombstones')
      return (script.tombstone ?? NO_TOMB) as never
    }),
    cancelledOrders: vi.fn(async () => {
      calls.push('cancelledOrders')
      const v = cancelledSeq[Math.min(ci++, cancelledSeq.length - 1)]
      if (v instanceof Error) throw v
      return v
    }),
    releaseOrderLock: vi.fn(async () => {
      calls.push('releaseOrderLock')
      const tx = script.releaseTx ?? { hash: '0xtxhash', status: 1 }
      return { hash: tx.hash, wait: async () => ({ status: tx.status }) }
    }),
  }
  return { vault, calls }
}

function fakeSettlement(filledIn: bigint) {
  const settlement: SettlementFilledLike = {
    orderFilledIn: vi.fn(async () => filledIn),
  }
  return settlement
}

describe('hardCancelOrderOnChain（第 46/47 轮）', () => {
  it('从未落锁 → never-locked，不发交易', async () => {
    const { vault, calls } = fakeVault({ locks: [NO_LOCK] })
    const res = await hardCancelOrderOnChain({
      order: ORDER,
      chainId: CHAIN,
      signer: wallet,
      vault,
    })
    expect(res.status).toBe('never-locked')
    expect(calls).toEqual(['orderLocks', 'cancelledOrders', 'lockTombstones'])
    // digest 与生产重算口径一致
    const data = buildSignedOrderData(ORDER, CHAIN)!
    expect(res.digest).toBe(computeOrderDigest(data, CHAIN))
  })

  it('已撤单作废（墓碑在、未全成交）→ already-cancelled', async () => {
    const { vault } = fakeVault({ locks: [NO_LOCK], cancelled: [true] })
    const res = await hardCancelOrderOnChain({
      order: ORDER,
      chainId: CHAIN,
      signer: wallet,
      vault,
      settlement: fakeSettlement(40n * 10n ** 18n),
    })
    expect(res.status).toBe('already-cancelled')
  })

  it('已全部成交（墓碑在、累计已满）→ filled', async () => {
    const data = buildSignedOrderData(ORDER, CHAIN)!
    const { vault } = fakeVault({ locks: [NO_LOCK], cancelled: [true] })
    const res = await hardCancelOrderOnChain({
      order: ORDER,
      chainId: CHAIN,
      signer: wallet,
      vault,
      settlement: fakeSettlement(BigInt(data.amountIn)),
    })
    expect(res.status).toBe('filled')
  })

  it('锁定已随过期释放（落锁墓碑在、无撤单墓碑、无锁）→ expired-released', async () => {
    const { vault } = fakeVault({
      locks: [NO_LOCK],
      cancelled: [false],
      tombstone: MY_TOMB,
    })
    const res = await hardCancelOrderOnChain({
      order: ORDER,
      chainId: CHAIN,
      signer: wallet,
      vault,
    })
    expect(res.status).toBe('expired-released')
  })

  it('旧栈降级（cancelledOrders 读口不存在）→ 无锁归入 never-locked，不再深挖', async () => {
    const { vault, calls } = fakeVault({
      locks: [NO_LOCK],
      cancelled: [new Error('method not found')],
    })
    const res = await hardCancelOrderOnChain({
      order: ORDER,
      chainId: CHAIN,
      signer: wallet,
      vault,
    })
    expect(res.status).toBe('never-locked')
    expect(calls).toEqual(['orderLocks', 'cancelledOrders'])
  })

  it('锁属本人 → 发交易、等回执、回读锁消失且墓碑已置位才报 released', async () => {
    const { vault, calls } = fakeVault({
      locks: [MY_LOCK, NO_LOCK],
      cancelled: [true],
    })
    const res = await hardCancelOrderOnChain({
      order: ORDER,
      chainId: CHAIN,
      signer: wallet,
      vault,
    })
    expect(res).toMatchObject({ status: 'released', txHash: '0xtxhash' })
    expect(calls).toEqual([
      'orderLocks',
      'releaseOrderLock',
      'orderLocks',
      'cancelledOrders',
    ])
  })

  it('释放后回读墓碑未置位 → 抛错，不报成功', async () => {
    const { vault } = fakeVault({
      locks: [MY_LOCK, NO_LOCK],
      cancelled: [false],
    })
    await expect(
      hardCancelOrderOnChain({ order: ORDER, chainId: CHAIN, signer: wallet, vault }),
    ).rejects.toThrow('未确认永久作废标记')
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
