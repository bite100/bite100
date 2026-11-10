/**
 * 第 34 轮双读 — 链上状态批量读取（状态机的权威数据源）。
 *
 * 读取面（全部 view 函数，按订单 digest 批量）：
 * - Settlement.orderFilledIn / orderFilledOut(digest)：该订单自身方向的
 *   累计成交（src/OrderVolumeTracker.sol 语义，见轮次文档状态机规范）；
 * - Settlement.nonceBitmap(user, wordPos)：nonce 是否已被任一结算消费
 *   （第 62 轮无序位图：读 nonce 所在字后做位测试；Settlement 继承
 *   OrderNonceManager，位图就在 Settlement 上）；
 * - Vault.orderLocks(digest)：活跃锁（user/token/remaining/expiresAt），
 *   user 为零地址 = 无活跃锁；
 * - Vault.lockTombstones(digest)：曾落锁的墓碑（释放/耗尽后不删），
 *   user 为零地址 = 从未落锁；
 * - Settlement.verifyOrderSignature(signedOrder)：仅在本地 ecrecover
 *   验签失败时才补查（MakerVault 等 ERC-1271 合约签名者的兜底）。
 *
 * 实现纪律（简报）：走 viem multicall 批量调用，不逐单逐项打 RPC；
 * 按区块高度做单槽缓存（同区块重复快照零新增 RPC）；不新造通用缓存框架。
 * 传输层可注入，便于单测 mock 三源故障。
 */
import { createPublicClient, http } from 'viem'
import { sepolia, baseSepolia } from 'viem/chains'
import { getChainConfig } from '../../config/chains'
import type { OrderData } from '../orderSigningTypes'
import type { ChainOrderState, ChainSnapshot } from './types'

/** 区块过旧阈值（秒）：最新区块 timestamp 与墙钟差超过此值视为 RPC/链异常陈旧 */
export const STALE_BLOCK_MAX_AGE_SEC = 900

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const ORDER_COMPONENTS = [
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
] as const

export const SETTLEMENT_READ_ABI = [
  {
    type: 'function',
    name: 'orderFilledIn',
    stateMutability: 'view',
    inputs: [{ name: 'digest', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'orderFilledOut',
    stateMutability: 'view',
    inputs: [{ name: 'digest', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'nonceBitmap',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'wordPos', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'verifyOrderSignature',
    stateMutability: 'view',
    inputs: [
      {
        name: 'signedOrder',
        type: 'tuple',
        components: [
          { name: 'order', type: 'tuple', components: ORDER_COMPONENTS },
          { name: 'signature', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

export const VAULT_READ_ABI = [
  {
    type: 'function',
    name: 'orderLocks',
    stateMutability: 'view',
    inputs: [{ name: 'digest', type: 'bytes32' }],
    outputs: [
      { name: 'user', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'remaining', type: 'uint256' },
      { name: 'expiresAt', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'lockTombstones',
    stateMutability: 'view',
    inputs: [{ name: 'digest', type: 'bytes32' }],
    outputs: [
      { name: 'user', type: 'address' },
      { name: 'token', type: 'address' },
    ],
  },
] as const

/** 一次批量调用项（传输层内部表示） */
export interface StateCall {
  contract: 'settlement' | 'vault'
  functionName: string
  args: unknown[]
}

export type StateCallResult =
  | { status: 'success'; result: unknown }
  | { status: 'failure' }

/** 可注入的链传输层：真实实现走 viem multicall，单测注入 mock */
export interface ChainTransport {
  getLatestBlock(): Promise<{ number: bigint; timestamp: number }>
  /**
   * 第 35 轮 D4：multicall 必须钉在 blockNumber 执行——旧实现取完最新区块
   * 后不带块号调用，读到的可能是 N+1 块状态却记在 N 块名下（过期判定用
   * N 块时间、成交/nonce/锁来自 N+1），快照自相矛盾。钉块后整份快照
   * 同属一个区块，缓存按该块号归属才诚实。
   */
  multicall(calls: StateCall[], blockNumber: bigint): Promise<StateCallResult[]>
}

export interface ChainStateRequest {
  digest: string
  userAddress: string
  nonce: number
  /** 本地验签全部未通过时才提供的链上验签材料（ERC-1271 兜底） */
  verifyOrder?: { data: OrderData; signature: string }
}

export interface ChainStateReader {
  snapshot(chainId: number, requests: ChainStateRequest[]): Promise<ChainSnapshot>
}

function toBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') return BigInt(Math.trunc(v))
  if (typeof v === 'string' && v !== '') return BigInt(v)
  return 0n
}

function tupleAt(result: unknown, idx: number): unknown {
  if (Array.isArray(result)) return result[idx]
  return undefined
}

function namedOrIdx(result: unknown, name: string, idx: number): unknown {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const rec = result as Record<string, unknown>
    if (name in rec) return rec[name]
  }
  return tupleAt(result, idx)
}

/** 把一次 multicall 的原始结果组装成 ChainOrderState；任一核心项失败返回 null。
 * 第 62 轮：第 3 项是 nonceBitmap 的整个字（uint256），nonceUsed 由调用方
 * 传入的 bitPos（nonce 低 8 位）做位测试得出。 */
export function assembleChainState(
  results: StateCallResult[],
  bitPos = 0,
): ChainOrderState | null {
  // 约定顺序：filledIn, filledOut, nonceBitmapWord, lock, tombstone, [verify?]
  if (results.length < 5) return null
  for (let i = 0; i < 5; i++) {
    if (results[i].status !== 'success') return null
  }
  const ok = (i: number) => (results[i] as { result: unknown }).result
  const lockRaw = ok(3)
  const lockUser = String(namedOrIdx(lockRaw, 'user', 0) ?? ZERO_ADDRESS)
  const tombRaw = ok(4)
  const tombUser = String(namedOrIdx(tombRaw, 'user', 0) ?? ZERO_ADDRESS)
  const state: ChainOrderState = {
    filledIn: toBigInt(ok(0)),
    filledOut: toBigInt(ok(1)),
    nonceUsed: ((toBigInt(ok(2)) >> BigInt(bitPos)) & 1n) === 1n,
    lock:
      lockUser.toLowerCase() === ZERO_ADDRESS
        ? null
        : {
            user: lockUser,
            token: String(namedOrIdx(lockRaw, 'token', 1) ?? ZERO_ADDRESS),
            remaining: toBigInt(namedOrIdx(lockRaw, 'remaining', 2)),
            expiresAt: toBigInt(namedOrIdx(lockRaw, 'expiresAt', 3)),
          },
    tombstone:
      tombUser.toLowerCase() === ZERO_ADDRESS
        ? null
        : {
            user: tombUser,
            token: String(namedOrIdx(tombRaw, 'token', 1) ?? ZERO_ADDRESS),
          },
  }
  if (results.length > 5 && results[5].status === 'success') {
    state.chainSignatureValid = Boolean((results[5] as { result: unknown }).result)
  }
  return state
}

export function buildStateCalls(req: ChainStateRequest): StateCall[] {
  const digest = req.digest as `0x${string}`
  const calls: StateCall[] = [
    { contract: 'settlement', functionName: 'orderFilledIn', args: [digest] },
    { contract: 'settlement', functionName: 'orderFilledOut', args: [digest] },
    {
      contract: 'settlement',
      functionName: 'nonceBitmap',
      args: [req.userAddress, BigInt(Math.floor(req.nonce / 256))],
    },
    { contract: 'vault', functionName: 'orderLocks', args: [digest] },
    { contract: 'vault', functionName: 'lockTombstones', args: [digest] },
  ]
  if (req.verifyOrder) {
    const d = req.verifyOrder.data
    calls.push({
      contract: 'settlement',
      functionName: 'verifyOrderSignature',
      args: [
        {
          order: {
            orderId: d.orderId,
            userAddress: d.userAddress,
            tokenIn: d.tokenIn,
            tokenOut: d.tokenOut,
            amountIn: BigInt(d.amountIn),
            amountOut: BigInt(d.amountOut),
            price: BigInt(d.price),
            timestamp: BigInt(d.timestamp),
            expiresAt: BigInt(d.expiresAt),
            nonce: BigInt(d.nonce),
          },
          signature: req.verifyOrder.signature,
        },
      ],
    })
  }
  return calls
}

interface CacheSlot {
  blockNumber: bigint
  blockTimestamp: number
  states: Map<string, ChainOrderState>
}

/**
 * 链上状态读取器：同一区块高度内已读过的 digest 直接复用（单槽缓存/链），
 * 新 digest 增量补读后并入同一区块槽。
 */
export function createChainStateReader(
  transportFor: (chainId: number) => ChainTransport,
  nowSec: () => number = () => Math.floor(Date.now() / 1000),
): ChainStateReader {
  const cache = new Map<number, CacheSlot>()
  return {
    async snapshot(chainId: number, requests: ChainStateRequest[]): Promise<ChainSnapshot> {
      const transport = transportFor(chainId)
      const block = await transport.getLatestBlock()
      const slot = cache.get(chainId)
      const sameBlock = slot && slot.blockNumber === block.number
      const states = new Map<string, ChainOrderState>(sameBlock ? slot.states : undefined)
      const missing = new Set<string>()
      const todo = requests.filter((r) => !states.has(r.digest.toLowerCase()))
      if (todo.length > 0) {
        const calls: StateCall[] = []
        const spans: Array<{ digest: string; start: number; len: number }> = []
        for (const req of todo) {
          const built = buildStateCalls(req)
          spans.push({ digest: req.digest.toLowerCase(), start: calls.length, len: built.length })
          calls.push(...built)
        }
        const results = await transport.multicall(calls, block.number)
        for (let i = 0; i < spans.length; i++) {
          const span = spans[i]
          const assembled = assembleChainState(
            results.slice(span.start, span.start + span.len),
            todo[i].nonce % 256,
          )
          if (assembled) states.set(span.digest, assembled)
          else missing.add(span.digest)
        }
      }
      cache.set(chainId, { blockNumber: block.number, blockTimestamp: block.timestamp, states })
      return {
        chainId,
        blockNumber: block.number,
        blockTimestamp: block.timestamp,
        stale: nowSec() - block.timestamp > STALE_BLOCK_MAX_AGE_SEC,
        states,
        missing,
      }
    },
  }
}

/** 本文件实际用到的 client 面（结构化，避免 viem 链型参数泛型纠缠） */
interface MinimalPublicClient {
  getBlock(): Promise<{ number: bigint | null; timestamp: bigint }>
  multicall(args: {
    contracts: unknown[]
    allowFailure: true
    /** 第 35 轮 D4：钉块读取（viem multicall 原生支持 blockNumber） */
    blockNumber: bigint
  }): Promise<Array<{ status: 'success' | 'failure'; result?: unknown; error?: unknown }>>
}

/** 真实传输层：viem public client + multicall（按链缓存 client 实例） */
export function createViemChainTransport(): (chainId: number) => ChainTransport {
  const clients = new Map<number, MinimalPublicClient>()
  const clientFor = (chainId: number): MinimalPublicClient => {
    const existing = clients.get(chainId)
    if (existing) return existing
    const cfg = getChainConfig(chainId)
    if (!cfg) throw new Error(`unknown chain ${chainId}`)
    const chain = chainId === baseSepolia.id ? baseSepolia : sepolia
    const client = createPublicClient({
      chain,
      transport: http(cfg.rpcUrl),
    }) as unknown as MinimalPublicClient
    clients.set(chainId, client)
    return client
  }
  return (chainId: number): ChainTransport => {
    const cfg = getChainConfig(chainId)
    if (!cfg) throw new Error(`unknown chain ${chainId}`)
    return {
      async getLatestBlock() {
        const block = await clientFor(chainId).getBlock()
        return { number: block.number ?? 0n, timestamp: Number(block.timestamp) }
      },
      async multicall(calls: StateCall[], blockNumber: bigint): Promise<StateCallResult[]> {
        const client = clientFor(chainId)
        const contracts = calls.map((c) => ({
          address: (c.contract === 'settlement'
            ? cfg.contracts.settlement
            : cfg.contracts.vault) as `0x${string}`,
          abi: (c.contract === 'settlement' ? SETTLEMENT_READ_ABI : VAULT_READ_ABI) as never,
          functionName: c.functionName as never,
          args: c.args as never,
        }))
        const results = await client.multicall({ contracts, allowFailure: true, blockNumber })
        return results.map((r) =>
          r.status === 'success'
            ? { status: 'success' as const, result: r.result }
            : { status: 'failure' as const },
        )
      },
    }
  }
}
