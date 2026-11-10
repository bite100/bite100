/**
 * 测试辅助：用公开的 anvil/hardhat 测试私钥 #1 构造真实签名的订单。
 * 该私钥是全网公开的测试材料（地址 0x70997970C51812dc3A010C7d01b50e0d17dc79C8），
 * 不是任何人的真实账户密钥。
 */
import { privateKeyToAccount } from 'viem/accounts'
import { BUILTIN_CHAINS, pairTokens } from '../src/config'
import { ORDER_TYPES, sideStringToUint, type NodeOrderBody } from '../src/orders'

export const TEST_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
export const account = privateKeyToAccount(TEST_PRIVATE_KEY)
export const TEST_ADDRESS = account.address

/** 第二测试账户（anvil/hardhat #2，公开测试材料）——跨用户用例用 */
export const TEST_PRIVATE_KEY_2 =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const
export const account2 = privateKeyToAccount(TEST_PRIVATE_KEY_2)
export const TEST_ADDRESS_2 = account2.address

let counter = 0
/**
 * 未显式指定 nonce 时的自动分配（第 62 轮块 D 起）：中继新增在途撞号
 * 拒绝后，同账户同 nonce 的两张不同订单不再能同时入库——这正是真实
 * 客户端（位图分配器）保证的性质。测试默认从高位基数自动递增发号，
 * 撞号用例显式传 nonce。
 */
let autoNonce = 100_000

export interface MakeOrderOpts {
  pair?: string
  /** 显式代币对（第六十轮自助上架对用：绕过符号表，按注册表地址签名） */
  tokens?: { tokenIn: string; tokenOut: string }
  side?: 'buy' | 'sell'
  /** wei 整数字符串 */
  price?: string
  /** wei 整数字符串 */
  amount?: string
  chainId?: number
  expiresAt?: number
  createdAt?: number
  nonce?: number
  orderId?: string
  /** 签名账户（缺省主测试账户；跨用户用例传 account2） */
  signer?: typeof account
}

/** 构造一张按规范签名的订单消息（与前端下单路径同一签名口径） */
export async function makeSignedOrder(opts: MakeOrderOpts = {}): Promise<NodeOrderBody> {
  const chainId = opts.chainId ?? 11155111
  const chain = BUILTIN_CHAINS[chainId]
  if (!chain) throw new Error(`no builtin chain ${chainId}`)
  const pair = opts.pair ?? 'BTC/USDT'
  const tokens = opts.tokens ?? pairTokens(chain, pair)
  if (!tokens) throw new Error(`unknown pair ${pair}`)
  const amount = opts.amount ?? '1000000000000000000' // 1e18
  const price = opts.price ?? '60000000000000000000000' // 60000e18
  const amountOut = (BigInt(amount) * BigInt(price)) / 10n ** 18n
  const createdAt = opts.createdAt ?? Math.floor(Date.now() / 1000)
  const expiresAt = opts.expiresAt ?? createdAt + 86400
  const orderId = opts.orderId ?? `test-order-${Date.now()}-${counter++}`
  const signer = opts.signer ?? account
  const nonce = opts.nonce ?? autoNonce++
  const message = {
    orderId,
    userAddress: signer.address,
    tokenIn: tokens.tokenIn as `0x${string}`,
    tokenOut: tokens.tokenOut as `0x${string}`,
    amountIn: BigInt(amount),
    amountOut,
    price: BigInt(price),
    timestamp: BigInt(createdAt),
    expiresAt: BigInt(expiresAt),
    nonce: BigInt(nonce),
    // 签名字段 side（uint8，规范 §2）：与下方请求体 side 字符串同一映射
    side: sideStringToUint(opts.side ?? 'buy'),
  }
  const signature = await signer.signTypedData({
    domain: {
      name: '比特100',
      version: '1',
      chainId,
      verifyingContract: chain.settlement as `0x${string}`,
    },
    types: ORDER_TYPES,
    primaryType: 'Order',
    message,
  })
  return {
    orderId,
    trader: signer.address,
    pair,
    side: opts.side ?? 'buy',
    price,
    amount,
    filled: '0',
    status: 'open',
    nonce,
    createdAt,
    expiresAt,
    signature,
    chainId,
  }
}
