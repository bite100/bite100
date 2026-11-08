/**
 * 订单形状、签名订单重建与 EIP-712 验签。
 *
 * 输入形状 = 节点 POST /api/order 的请求体（node/internal/storage/orders.go 的
 * storage.Order）：{ orderId, trader, pair, side, price, amount, filled, status,
 * nonce, createdAt, expiresAt, signature, execType? }，其中 price/amount 是
 * wei 整数字符串。中继额外接受可选 chainId（节点是单链进程没有这个字段；
 * 中继多链，必须知道按哪条链的域验签，缺省 = Sepolia）。
 *
 * 验签重建与节点 match.BuildSignedOrder 逐项一致：
 *   tokenIn/tokenOut = 交易对 (Token0, Token1)，与买卖方向无关；
 *   amountIn = amount，price = price，amountOut = amountIn * price / 1e18；
 *   timestamp = createdAt；expiresAt 缺省 = createdAt + 7 天；nonce = nonce；
 *   side = 订单行自报 side 字符串映射为 uint8（规范 §2：buy ↔ 0、sell ↔ 1，
 *   置于签名结构末位，阶段 3 新增签名字段）。
 * 验签只用 viem 的 verifyTypedData / hashTypedData（现成库），不手写密码学。
 */
import {
  createPublicClient,
  hashTypedData,
  http,
  verifyTypedData,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from 'viem'
import { baseSepolia, sepolia } from 'viem/chains'
import { DOMAIN_NAME, DOMAIN_VERSION, pairTokens, type ChainRelayConfig } from './config'

export const ORDER_TYPES = {
  Order: [
    { name: 'orderId', type: 'string' },
    { name: 'userAddress', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'amountOut', type: 'uint256' },
    { name: 'price', type: 'uint256' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'side', type: 'uint8' },
  ],
} as const

/** 节点 /api/order 请求体形状（中继 POST /orders 与之对齐，另加可选 chainId） */
export interface NodeOrderBody {
  orderId: string
  trader: string
  pair: string
  side: string
  price: string
  amount: string
  filled?: string
  status?: string
  nonce: number
  createdAt: number
  expiresAt?: number
  signature: string
  execType?: string
  chainId?: number
}

/** 重建出的签名订单（EIP-712 message） */
export interface SignedOrder {
  orderId: string
  userAddress: Address
  tokenIn: Address
  tokenOut: Address
  amountIn: bigint
  amountOut: bigint
  price: bigint
  timestamp: bigint
  expiresAt: bigint
  nonce: bigint
  /** 签名方向（uint8）：0 = buy、1 = sell（规范 §2） */
  side: number
}

const SCALE_1E18 = 10n ** 18n
const DEFAULT_TTL_SEC = 7 * 24 * 3600

function parseUint(v: unknown, field: string): bigint {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`invalid ${field}`)
    return BigInt(v)
  }
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) return BigInt(v)
  throw new Error(`invalid ${field}`)
}

function parseIntField(v: unknown, field: string): number {
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
    throw new Error(`invalid ${field}`)
  }
  return n
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/

/** 基础字段校验（与节点 handlePostOrder 的必填校验同口径）。不合规抛 Error（调用方回 400）。 */
export function validateBody(raw: unknown): NodeOrderBody {
  if (typeof raw !== 'object' || raw === null) throw new Error('invalid json body')
  const b = raw as Record<string, unknown>
  for (const f of ['orderId', 'pair', 'side', 'price', 'amount'] as const) {
    if (typeof b[f] !== 'string' || (b[f] as string) === '') {
      throw new Error(`missing required field: ${f}`)
    }
  }
  if (typeof b.signature !== 'string' || b.signature === '') {
    throw new Error('signature required')
  }
  if (!SIGNATURE_RE.test(b.signature as string)) throw new Error('invalid signature')
  if (typeof b.trader !== 'string' || !ADDRESS_RE.test(b.trader)) {
    throw new Error('invalid trader')
  }
  if (b.side !== 'buy' && b.side !== 'sell') throw new Error('invalid side')
  if (
    b.execType !== undefined &&
    b.execType !== '' &&
    b.execType !== 'limit' &&
    b.execType !== 'market'
  ) {
    throw new Error('invalid execType')
  }
  // price/amount 必须是 wei 整数字符串（节点 SetString 十进制整数同口径）
  parseUint(b.price, 'price')
  parseUint(b.amount, 'amount')
  return {
    orderId: b.orderId as string,
    trader: b.trader as string,
    pair: b.pair as string,
    side: b.side as string,
    price: b.price as string,
    amount: b.amount as string,
    filled: typeof b.filled === 'string' ? b.filled : '0',
    status: typeof b.status === 'string' && b.status !== '' ? b.status : 'open',
    nonce: parseIntField(b.nonce, 'nonce'),
    createdAt: parseIntField(b.createdAt, 'createdAt'),
    expiresAt:
      b.expiresAt === undefined || b.expiresAt === 0
        ? undefined
        : parseIntField(b.expiresAt, 'expiresAt'),
    signature: b.signature as string,
    execType: typeof b.execType === 'string' ? b.execType : undefined,
    chainId: b.chainId === undefined ? undefined : parseIntField(b.chainId, 'chainId'),
  }
}

/**
 * 订单行自报 side 字符串 -> 签名字段 side（uint8）的映射，与规范
 * docs/eip712-order-spec.md §2 一一对应：buy ↔ 0、sell ↔ 1。
 * validateBody 已保证入库路径的 side 只为 buy/sell；本函数对其它值直接抛错，
 * 防止未经校验直接调用 buildSignedOrder 时把非法方向悄悄编进签名消息。
 */
export function sideStringToUint(side: string): number {
  switch (side) {
    case 'buy':
      return 0
    case 'sell':
      return 1
    default:
      throw new Error(`invalid side: ${side}`)
  }
}

/** 按节点 BuildSignedOrder 的同一映射重建签名订单；交易对未登记返回 null */
export function buildSignedOrder(
  chain: ChainRelayConfig,
  body: NodeOrderBody,
): SignedOrder | null {
  const tokens = pairTokens(chain, body.pair)
  if (!tokens) return null
  const amountIn = BigInt(body.amount)
  const price = BigInt(body.price)
  const amountOut = (amountIn * price) / SCALE_1E18
  const expiresAt = body.expiresAt ?? body.createdAt + DEFAULT_TTL_SEC
  return {
    orderId: body.orderId,
    userAddress: body.trader as Address,
    tokenIn: tokens.tokenIn as Address,
    tokenOut: tokens.tokenOut as Address,
    amountIn,
    amountOut,
    price,
    timestamp: BigInt(body.createdAt),
    expiresAt: BigInt(expiresAt),
    nonce: BigInt(body.nonce),
    side: sideStringToUint(body.side),
  }
}

export function domainFor(chain: ChainRelayConfig) {
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: chain.chainId,
    verifyingContract: chain.settlement as Address,
  } as const
}

/** 订单 EIP-712 digest（去重键；与 Settlement.orderDigest 同值） */
export function orderDigest(chain: ChainRelayConfig, so: SignedOrder): Hex {
  return hashTypedData({
    domain: domainFor(chain),
    types: ORDER_TYPES,
    primaryType: 'Order',
    message: so,
  })
}

/** 可注入的验签依赖（单测用 mock 替身验证 ERC-1271 回退路径） */
export interface VerifyDeps {
  /** 按链造 publicClient；返回 null 表示该链无 RPC 配置（回退不可用） */
  getPublicClient?: (chain: ChainRelayConfig) => PublicClient | null
}

const VIEM_CHAINS: Record<number, Chain> = {
  11155111: sepolia,
  84532: baseSepolia,
}

const clientCache = new Map<number, PublicClient>()

/** 默认 publicClient 工厂：用链配置的 rpcUrl（Workers 里按链缓存复用） */
export function defaultGetPublicClient(chain: ChainRelayConfig): PublicClient | null {
  if (!chain.rpcUrl) return null
  const cached = clientCache.get(chain.chainId)
  if (cached) return cached
  const client = createPublicClient({
    chain: VIEM_CHAINS[chain.chainId],
    transport: http(chain.rpcUrl, { timeout: 10_000 }),
  }) as PublicClient
  clientCache.set(chain.chainId, client)
  return client
}

/**
 * 验签（双路，与节点 handlePostOrder 的两段式同口径）：
 *  1. EOA 快路径：viem 纯本地 verifyTypedData（ecrecover == userAddress），不走网络；
 *  2. ERC-1271 回退：快路径失败且该链配了 RPC 时，用 publicClient.verifyTypedData
 *     ——viem 的现成能力：它先查 userAddress 有无代码，无代码直接 false，有代码则
 *     eth_call 该合约的 isValidSignature(hash, signature)（MakerVault 等合约账户
 *     靠注册签名者代签，恢复地址 ≠ userAddress，纯 ecrecover 必然失败，必须走这路）。
 * RPC 出错 → fail-closed 返回 false（不放行），与节点「RPC 错误 → 400」一致。
 */
export async function verifyOrder(
  chain: ChainRelayConfig,
  so: SignedOrder,
  signature: string,
  deps: VerifyDeps = {},
): Promise<boolean> {
  const args = {
    address: so.userAddress,
    domain: domainFor(chain),
    types: ORDER_TYPES,
    primaryType: 'Order' as const,
    message: so,
    signature: signature as Hex,
  }
  try {
    if (await verifyTypedData(args)) return true
  } catch {
    // 本地验签异常（签名格式问题等）继续走回退判定，最终以回退/拒绝为准
  }
  const getClient = deps.getPublicClient ?? defaultGetPublicClient
  const client = getClient(chain)
  if (!client) return false
  try {
    // args 与本地路径同一份入参；PublicClient 的泛型签名比运行时要求更严，做一次定点转换
    return await client.verifyTypedData(
      args as unknown as Parameters<PublicClient['verifyTypedData']>[0],
    )
  } catch {
    return false // RPC 不可用 → fail-closed
  }
}
