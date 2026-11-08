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

let counter = 0

export interface MakeOrderOpts {
  pair?: string
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
}

/** 构造一张按规范签名的订单消息（与前端下单路径同一签名口径） */
export async function makeSignedOrder(opts: MakeOrderOpts = {}): Promise<NodeOrderBody> {
  const chainId = opts.chainId ?? 11155111
  const chain = BUILTIN_CHAINS[chainId]
  if (!chain) throw new Error(`no builtin chain ${chainId}`)
  const pair = opts.pair ?? 'BTC/USDT'
  const tokens = pairTokens(chain, pair)
  if (!tokens) throw new Error(`unknown pair ${pair}`)
  const amount = opts.amount ?? '1000000000000000000' // 1e18
  const price = opts.price ?? '60000000000000000000000' // 60000e18
  const amountOut = (BigInt(amount) * BigInt(price)) / 10n ** 18n
  const createdAt = opts.createdAt ?? Math.floor(Date.now() / 1000)
  const expiresAt = opts.expiresAt ?? createdAt + 86400
  const orderId = opts.orderId ?? `test-order-${Date.now()}-${counter++}`
  const message = {
    orderId,
    userAddress: TEST_ADDRESS,
    tokenIn: tokens.tokenIn as `0x${string}`,
    tokenOut: tokens.tokenOut as `0x${string}`,
    amountIn: BigInt(amount),
    amountOut,
    price: BigInt(price),
    timestamp: BigInt(createdAt),
    expiresAt: BigInt(expiresAt),
    nonce: BigInt(opts.nonce ?? 0),
    // 签名字段 side（uint8，规范 §2）：与下方请求体 side 字符串同一映射
    side: sideStringToUint(opts.side ?? 'buy'),
  }
  const signature = await account.signTypedData({
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
    trader: TEST_ADDRESS,
    pair,
    side: opts.side ?? 'buy',
    price,
    amount,
    filled: '0',
    status: 'open',
    nonce: opts.nonce ?? 0,
    createdAt,
    expiresAt,
    signature,
    chainId,
  }
}
