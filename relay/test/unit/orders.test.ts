import { describe, expect, it, vi } from 'vitest'
import { BUILTIN_CHAINS, pairTokens } from '../../src/config'
import {
  buildSignedOrder,
  orderDigest,
  validateBody,
  verifyOrder,
  ORDER_TYPES,
} from '../../src/orders'
import { account, makeSignedOrder, TEST_ADDRESS } from '../helpers'

const sepolia = BUILTIN_CHAINS[11155111]

describe('buildSignedOrder（与节点 BuildSignedOrder 同映射）', () => {
  it('tokenIn/tokenOut 取交易对 (base, quote)，amountOut 按公式派生', async () => {
    const body = await makeSignedOrder({ amount: '2000000000000000000', price: '3000000000000000000000' })
    const so = buildSignedOrder(sepolia, body)
    expect(so).not.toBeNull()
    expect(so!.tokenIn).toBe(sepolia.tokens.BTC)
    expect(so!.tokenOut).toBe(sepolia.tokens.USDT)
    // 2e18 * 3000e18 / 1e18 = 6000e18
    expect(so!.amountOut.toString()).toBe('6000000000000000000000')
    expect(so!.userAddress).toBe(TEST_ADDRESS)
  })

  it('expiresAt 缺省 = createdAt + 7 天（节点同口径）', async () => {
    const body = await makeSignedOrder({})
    delete body.expiresAt
    const so = buildSignedOrder(sepolia, body)
    expect(Number(so!.expiresAt)).toBe(body.createdAt + 7 * 24 * 3600)
  })

  it('未登记交易对返回 null', async () => {
    const body = await makeSignedOrder({})
    body.pair = 'FOO/BAR'
    expect(buildSignedOrder(sepolia, body)).toBeNull()
  })
})

describe('verifyOrder / orderDigest', () => {
  it('真实签名验签通过，digest 为 0x+64hex', async () => {
    const body = await makeSignedOrder({})
    const so = buildSignedOrder(sepolia, body)!
    expect(await verifyOrder(sepolia, so, body.signature)).toBe(true)
    expect(orderDigest(sepolia, so)).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('篡改 amount 后验签失败', async () => {
    const body = await makeSignedOrder({})
    const tampered = { ...body, amount: '999000000000000000000' }
    // 关掉 RPC 回退（rpcUrl 置空），只断言本地验签结论，保持单测不依赖网络
    const localOnly = { ...sepolia, rpcUrl: '' }
    const so = buildSignedOrder(localOnly, tampered)!
    expect(await verifyOrder(localOnly, so, body.signature)).toBe(false)
  })

  it('换链域（Base Sepolia）验 Sepolia 签名失败，按 Base 域验本链签名通过', async () => {
    const base = { ...BUILTIN_CHAINS[84532], rpcUrl: '' }
    const sep = { ...sepolia, rpcUrl: '' }
    const bodyBase = await makeSignedOrder({ chainId: 84532 })
    const soBase = buildSignedOrder(base, bodyBase)!
    expect(await verifyOrder(base, soBase, bodyBase.signature)).toBe(true)
    // 同一张单拿 Sepolia 链配置重建（代币不同 + 域不同）必然验不过
    const soWrong = buildSignedOrder(sep, bodyBase)!
    expect(await verifyOrder(sep, soWrong, bodyBase.signature)).toBe(false)
    expect(orderDigest(base, soBase)).not.toBe(orderDigest(sep, soWrong))
  })

  it('同一订单 digest 稳定（去重键）', async () => {
    const body = await makeSignedOrder({})
    const a = orderDigest(sepolia, buildSignedOrder(sepolia, body)!)
    const b = orderDigest(sepolia, buildSignedOrder(sepolia, body)!)
    expect(a).toBe(b)
  })
})

describe('verifyOrder ERC-1271 双路（合约账户 / MakerVault）', () => {
  // 第 27 轮 Sepolia MakerVault 地址：userAddress 为合约，签名者是其注册签名者 EOA，
  // 纯 ecrecover 恢复出的地址 ≠ userAddress，必须走 RPC-backed isValidSignature 回退。
  const VAULT = '0xEFD02ae9E90C6d515299953A41c4788F2FceC09f' as const

  async function makeVaultOrder() {
    const tokens = pairTokens(sepolia, 'BTC/USDT')!
    const now = Math.floor(Date.now() / 1000)
    const message = {
      orderId: 'vault-order-1',
      userAddress: VAULT,
      tokenIn: tokens.tokenIn as `0x${string}`,
      tokenOut: tokens.tokenOut as `0x${string}`,
      amountIn: 1000000000000000000n,
      amountOut: 60000000000000000000000n,
      price: 60000000000000000000000n,
      timestamp: BigInt(now),
      expiresAt: BigInt(now + 86400),
      nonce: 0n,
    }
    // 测试钥扮演金库注册签名者代签（恢复地址 = 测试地址 ≠ 金库地址）
    const signature = await account.signTypedData({
      domain: {
        name: '比特100',
        version: '1',
        chainId: 11155111,
        verifyingContract: sepolia.settlement as `0x${string}`,
      },
      types: ORDER_TYPES,
      primaryType: 'Order',
      message,
    })
    const body = {
      orderId: 'vault-order-1',
      trader: VAULT,
      pair: 'BTC/USDT',
      side: 'buy',
      price: '60000000000000000000000',
      amount: '1000000000000000000',
      filled: '0',
      status: 'open',
      nonce: 0,
      createdAt: now,
      expiresAt: now + 86400,
      signature,
      chainId: 11155111,
    }
    return { body, so: buildSignedOrder(sepolia, body)! }
  }

  function stubClient(result: boolean | Error) {
    const verifyTypedData = vi.fn(async (_args: { address: string }) => {
      if (result instanceof Error) throw result
      return result
    })
    return {
      verifyTypedData,
      getPublicClient: () => ({ verifyTypedData }) as never,
    }
  }

  it('纯本地验签对金库订单必然失败（对照组：无 RPC 配置时拒绝）', async () => {
    const { body, so } = await makeVaultOrder()
    const noRpc = { ...sepolia, rpcUrl: '' }
    expect(await verifyOrder(noRpc, so, body.signature)).toBe(false)
  })

  it('本地失败 → 走 publicClient.verifyTypedData（ERC-1271），合约认可则通过', async () => {
    const { body, so } = await makeVaultOrder()
    const stub = stubClient(true)
    expect(await verifyOrder(sepolia, so, body.signature, stub)).toBe(true)
    // 回退确实以 userAddress=金库地址发起 RPC 校验
    expect(stub.verifyTypedData).toHaveBeenCalledTimes(1)
    expect(stub.verifyTypedData.mock.calls[0][0].address).toBe(VAULT)
  })

  it('合约拒绝（isValidSignature 不认可）→ 验签失败', async () => {
    const { body, so } = await makeVaultOrder()
    expect(await verifyOrder(sepolia, so, body.signature, stubClient(false))).toBe(false)
  })

  it('RPC 出错 → fail-closed 拒绝，不放行', async () => {
    const { body, so } = await makeVaultOrder()
    expect(
      await verifyOrder(sepolia, so, body.signature, stubClient(new Error('rpc down'))),
    ).toBe(false)
  })

  it('EOA 订单走快路径，不触 RPC（stub 不应被调用）', async () => {
    const body = await makeSignedOrder({})
    const so = buildSignedOrder(sepolia, body)!
    const stub = stubClient(false)
    expect(await verifyOrder(sepolia, so, body.signature, stub)).toBe(true)
    expect(stub.verifyTypedData).not.toHaveBeenCalled()
  })
})

describe('validateBody', () => {
  it('缺签名 / 非法 execType / 小数 price 均拒绝', async () => {
    const body = await makeSignedOrder({})
    expect(() => validateBody({ ...body, signature: '' })).toThrow(/signature/)
    expect(() => validateBody({ ...body, execType: 'ioc' })).toThrow(/execType/)
    expect(() => validateBody({ ...body, price: '1.5' })).toThrow(/price/)
    expect(() => validateBody({ ...body, side: 'hold' })).toThrow(/side/)
  })

  it('合法体通过并归一化缺省 filled/status', async () => {
    const body = await makeSignedOrder({})
    const { filled, status, ...rest } = body
    const v = validateBody(rest)
    expect(v.filled).toBe('0')
    expect(v.status).toBe('open')
  })
})
