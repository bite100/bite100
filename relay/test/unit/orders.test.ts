import { describe, expect, it, vi } from 'vitest'
import { BUILTIN_CHAINS, pairTokens, type ChainRelayConfig } from '../../src/config'
import {
  _resetErc1271CodeCache,
  buildSignedOrder,
  orderDigest,
  sideStringToUint,
  validateBody,
  verifyOrder,
  ORDER_TYPES,
  type NodeOrderBody,
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
      side: 0, // 与下方请求体 side: 'buy' 对应（规范 §2：buy ↔ 0）
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

  it('第 59 轮：已知 EOA（getCode=0x）→ 跳过 ERC-1271 RPC 回退，本地直接拒绝', async () => {
    _resetErc1271CodeCache()
    const { body, so } = await makeVaultOrder()
    const getCode = vi.fn(async (_args: { address: string }) => '0x' as const)
    const verifyTypedData = vi.fn(async (_args: { address: string }) => true)
    const deps = { getPublicClient: () => ({ getCode, verifyTypedData }) as never }
    // 本地验签对金库订单必然失败（签名者 ≠ VAULT）；回退若被调用会
    // 返回 true——结果必须是 false 且 verifyTypedData 从未被调用，
    // 证明 EOA 短路生效（伪造订单不再逐张烧 eth_call）
    expect(await verifyOrder(sepolia, so, body.signature, deps)).toBe(false)
    expect(verifyTypedData).not.toHaveBeenCalled()
    expect(getCode).toHaveBeenCalledTimes(1)
    // 第二次同地址：命中 60 秒缓存，getCode 不再重复调用
    expect(await verifyOrder(sepolia, so, body.signature, deps)).toBe(false)
    expect(getCode).toHaveBeenCalledTimes(1)
    expect(verifyTypedData).not.toHaveBeenCalled()
  })

  it('第 59 轮：有合约代码 → 照常走 ERC-1271 回退判定', async () => {
    _resetErc1271CodeCache()
    const { body, so } = await makeVaultOrder()
    const getCode = vi.fn(async (_args: { address: string }) => '0x6001' as const)
    const verifyTypedData = vi.fn(async (_args: { address: string }) => true)
    const deps = { getPublicClient: () => ({ getCode, verifyTypedData }) as never }
    expect(await verifyOrder(sepolia, so, body.signature, deps)).toBe(true)
    expect(getCode).toHaveBeenCalledTimes(1)
    expect(verifyTypedData).toHaveBeenCalledTimes(1)
  })

  it('第 59 轮：getCode 出错 → 未知，不短路（照常回退，RPC 错仍 fail-closed）', async () => {
    _resetErc1271CodeCache()
    const { body, so } = await makeVaultOrder()
    const getCode = vi.fn(async (_args: { address: string }) => {
      throw new Error('rpc down')
    })
    const verifyTypedData = vi.fn(async (_args: { address: string }) => true)
    const deps = { getPublicClient: () => ({ getCode, verifyTypedData }) as never }
    expect(await verifyOrder(sepolia, so, body.signature, deps)).toBe(true)
    expect(verifyTypedData).toHaveBeenCalledTimes(1)
  })
})

describe('阶段 3 side 签名字段（规范 §2）', () => {
  it('ORDER_TYPES 与规范类型串逐字一致（side 为 uint8、置于末位）', () => {
    const typeString = `Order(${ORDER_TYPES.Order.map((f) => `${f.type} ${f.name}`).join(',')})`
    expect(typeString).toBe(
      'Order(string orderId,address userAddress,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut,uint256 price,uint256 timestamp,uint256 expiresAt,uint256 nonce,uint8 side)',
    )
    expect(ORDER_TYPES.Order[ORDER_TYPES.Order.length - 1]).toEqual({
      name: 'side',
      type: 'uint8',
    })
  })

  it('buildSignedOrder 映射：buy -> 0、sell -> 1（与订单行 side 字符串一一对应）', async () => {
    const buy = await makeSignedOrder({ side: 'buy' })
    expect(buildSignedOrder(sepolia, buy)!.side).toBe(0)
    // 签名消息由 helpers 以同一映射签名，两种方向重建后均可验签
    expect(await verifyOrder(sepolia, buildSignedOrder(sepolia, buy)!, buy.signature)).toBe(true)
    const sell = await makeSignedOrder({ side: 'sell' })
    expect(buildSignedOrder(sepolia, sell)!.side).toBe(1)
    expect(await verifyOrder(sepolia, buildSignedOrder(sepolia, sell)!, sell.signature)).toBe(
      true,
    )
    expect(sideStringToUint('buy')).toBe(0)
    expect(sideStringToUint('sell')).toBe(1)
    expect(() => sideStringToUint('hold')).toThrow(/side/)
  })

  it('side 被签名绑死：签后翻转订单行 side 字符串 -> 验签失败', async () => {
    const body = await makeSignedOrder({ side: 'buy' })
    const localOnly = { ...sepolia, rpcUrl: '' } // 关掉 RPC 回退，只看本地验签结论
    const flipped = { ...body, side: 'sell' }
    const so = buildSignedOrder(localOnly, flipped)!
    expect(so.side).toBe(1)
    expect(await verifyOrder(localOnly, so, body.signature)).toBe(false)
  })
})

describe('跨语言向量（规范 §6，ethers 生成，含 side 的新消息）', () => {
  // 域：name=比特100、version=1、chainId=31337、verifyingContract=anvil 首部署地址；
  // 交易对代币以向量 tokenIn/tokenOut 对齐（0x1111…/0x2222…），其余字段经
  // buildSignedOrder 的既有派生（amountOut = amountIn * price / 1e18）与向量自洽。
  const VECTOR_CHAIN: ChainRelayConfig = {
    chainId: 31337,
    settlement: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    rpcUrl: '',
    tokens: {
      AAA: '0x1111111111111111111111111111111111111111',
      BBB: '0x2222222222222222222222222222222222222222',
    },
  }
  const VECTOR_SIGNATURE =
    '0xc7d48a6fdc483a27fa1c04cdfa92b5e4fb162cd94c747ffca46b73222b34f9ae4c2751772e5e43bbcee2b9d84a46eee9a7e472fddcf1bd58542760c0afe9ec9c1b'
  const VECTOR_DIGEST = '0xd793d795036c2d1b548120e9e73ea43a608529b4a23f0d3254c263fde391cec0'

  function vectorBody(): NodeOrderBody {
    return {
      orderId: 'order_vector_1',
      trader: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      pair: 'AAA/BBB',
      side: 'sell',
      price: '2000000000000000000',
      amount: '100000000000000000000',
      nonce: 0,
      createdAt: 1700000000,
      expiresAt: 1700086400,
      signature: VECTOR_SIGNATURE,
    }
  }

  it('重建字段与向量逐项一致，digest 与向量逐字相等', () => {
    const so = buildSignedOrder(VECTOR_CHAIN, vectorBody())!
    expect(so.orderId).toBe('order_vector_1')
    expect(so.userAddress).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
    expect(so.tokenIn).toBe('0x1111111111111111111111111111111111111111')
    expect(so.tokenOut).toBe('0x2222222222222222222222222222222222222222')
    expect(so.amountIn).toBe(100000000000000000000n)
    expect(so.amountOut).toBe(200000000000000000000n)
    expect(so.price).toBe(2000000000000000000n)
    expect(so.timestamp).toBe(1700000000n)
    expect(so.expiresAt).toBe(1700086400n)
    expect(so.nonce).toBe(0n)
    expect(so.side).toBe(1)
    expect(orderDigest(VECTOR_CHAIN, so)).toBe(VECTOR_DIGEST)
  })

  it('向量签名（ethers / anvil 账户 #0）经 verifyOrder 本地路径验过', async () => {
    const so = buildSignedOrder(VECTOR_CHAIN, vectorBody())!
    expect(await verifyOrder(VECTOR_CHAIN, so, VECTOR_SIGNATURE)).toBe(true)
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
