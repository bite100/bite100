/**
 * 合成压测（第 35 轮 D-10a）— 合成订单生成器。
 *
 * 职责：用 maker/taker 测试钱包按现行协议签发真实 EIP-712 订单，
 * 双发到节点 API（主）与公告栏中继（副），供服务端影子层观察。
 *
 * 纪律：
 * - 密钥只从 SOAK_KEYS_DIR（默认 ~/workspace/bite100-deployer）的
 *   maker.env / taker.env 在运行时读取，绝不打印/落盘/进日志；
 *   解析只取文件中第一个 0x<64 hex> 令牌，不回显文件内容。
 * - 签名字段重构不另写一套：复用 dualread/digest 的 buildSignedOrderData
 *   与 computeOrderDigest（与前端/节点/中继三方同一口径），签名走既有
 *   ORDER_TYPES / getEIP712Domain（services/orderSigningTypes）。
 * - nonce 取链上 Settlement.getCurrentNonce（与前端 fetchOrderNonce
 *   同一口径），批次内顺序递增（结算逐单消费 nonce 的语义）。
 * - 每单先预检 Vault.availableBalance 是否覆盖落锁义务（卖单锁
 *   tokenIn×amountIn、买单锁 tokenOut×amountOut）：不足则跳过该单并
 *   在结果里给出确切缺口数字——本工具绝不自行给钱包注资。
 * - 提交限速：相邻提交间隔 ≥ SOAK_SUBMIT_GAP_MS（默认 2000ms），
 *   节点接单口有 IP 限流，压测不做压力洪泛。
 * - 仅测试网链（11155111 / 84532），其他 chainId 直接拒绝。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ethers } from 'ethers'
import { createPublicClient, http } from 'viem'
import { getChainConfig } from '../../src/config/chains'
import { getPairTokens } from '../../src/config/pairs'
import {
  ORDER_TYPES,
  getEIP712Domain,
  type OrderData,
} from '../../src/services/orderSigningTypes'
import {
  buildSignedOrderData,
  computeOrderDigest,
} from '../../src/services/dualread/digest'
import type { RawOrder } from '../../src/services/dualread/types'

export const TESTNET_CHAINS = [11155111, 84532] as const

const SETTLEMENT_NONCE_ABI = [
  {
    type: 'function',
    name: 'getCurrentNonce',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

const VAULT_AVAIL_ABI = [
  {
    type: 'function',
    name: 'availableBalance',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'token', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

export type WalletRole = 'maker' | 'taker'

export interface SoakWallet {
  role: WalletRole
  wallet: ethers.Wallet
  address: string
}

/** 从 env 文件提取私钥（第一个 0x<64hex> 令牌）；不回显任何文件内容 */
function extractKey(filePath: string): string {
  const text = readFileSync(filePath, 'utf8')
  const m = text.match(/0x[0-9a-fA-F]{64}/)
  if (!m) throw new Error(`密钥文件缺少私钥令牌: ${filePath.split('/').pop()}`)
  return m[0]
}

export function loadWallets(keysDir: string): SoakWallet[] {
  return (['maker', 'taker'] as const).map((role) => {
    const wallet = new ethers.Wallet(extractKey(join(keysDir, `${role}.env`)))
    return { role, wallet, address: wallet.address }
  })
}

function publicClient(chainId: number) {
  const cfg = getChainConfig(chainId)
  if (!cfg) throw new Error(`unknown chain ${chainId}`)
  return { cfg, client: createPublicClient({ transport: http(cfg.rpcUrl) }) }
}

export async function currentNonce(chainId: number, user: string): Promise<number> {
  const { cfg, client } = publicClient(chainId)
  const n = await client.readContract({
    address: cfg.contracts.settlement as `0x${string}`,
    abi: SETTLEMENT_NONCE_ABI,
    functionName: 'getCurrentNonce',
    args: [user as `0x${string}`],
  })
  return Number(n)
}

export async function vaultAvailable(
  chainId: number,
  user: string,
  token: string,
): Promise<bigint> {
  const { cfg, client } = publicClient(chainId)
  return client.readContract({
    address: cfg.contracts.vault as `0x${string}`,
    abi: VAULT_AVAIL_ABI,
    functionName: 'availableBalance',
    args: [user as `0x${string}`, token as `0x${string}`],
  })
}

export interface OrderSpec {
  role: WalletRole
  pair: string
  side: 'buy' | 'sell'
  /** 基础币数量（十进制字符串，如 "0.001"） */
  amount: string
  /** 计价币/基础币价格（十进制字符串，如 "2000"） */
  price: string
  execType?: 'market'
  /** 存活秒数（默认 3600；对抗场景可设短以制造过期单） */
  ttlSec?: number
}

export interface GeneratedOrder {
  chainId: number
  digest: string
  role: WalletRole
  pair: string
  side: 'buy' | 'sell'
  /** 提交给节点/中继的订单原文（两者同一份，relay 侧另加 chainId） */
  body: Record<string, unknown>
  createdAt: number
}

export interface GenSkip {
  spec: OrderSpec
  reason: string
  /** 预检缺口（wei 字符串）：义务量 / 可用量，便于人工核对 */
  obligation?: string
  available?: string
}

const WEI = 10n ** 18n
const toWei = (dec: string): bigint => ethers.parseUnits(dec, 18)

let orderSeq = 0

/**
 * 按规格批量签发（逐单预检 + 签名）。nonce 游标由调用方跨批次持有
 * （nonceCursor 参数）：首次为某 (链，钱包) 签发时读链上 getCurrentNonce
 * 作起点，之后顺序递增——链上 nonce 只在结算时消费，逐批重读会让不同
 * 订单共用同一 nonce，游标必须跨批次连续。
 */
export async function generateBatch(
  chainId: number,
  wallets: SoakWallet[],
  specs: OrderSpec[],
  nonceCursor: Map<string, number> = new Map(),
): Promise<{ generated: GeneratedOrder[]; skipped: GenSkip[] }> {
  if (!(TESTNET_CHAINS as readonly number[]).includes(chainId)) {
    throw new Error(`soak 只允许测试网链，拒绝 chainId=${chainId}`)
  }
  const byRole = new Map(wallets.map((w) => [w.role, w]))
  const generated: GeneratedOrder[] = []
  const skipped: GenSkip[] = []

  for (const spec of specs) {
    const w = byRole.get(spec.role)
    if (!w) {
      skipped.push({ spec, reason: `钱包 ${spec.role} 未加载` })
      continue
    }
    const tokens = getPairTokens(chainId, spec.pair)
    if (!tokens) {
      skipped.push({ spec, reason: `交易对未登记: ${spec.pair}` })
      continue
    }
    const amountIn = toWei(spec.amount)
    const price = toWei(spec.price)
    const amountOut = (amountIn * price) / WEI
    // 落锁义务（lock.go ObligationForOrder）：卖锁 tokenIn，买锁 tokenOut
    const obligationToken = spec.side === 'sell' ? tokens.base : tokens.quote
    const obligation = spec.side === 'sell' ? amountIn : amountOut
    const available = await vaultAvailable(chainId, w.address, obligationToken)
    if (available < obligation) {
      skipped.push({
        spec,
        reason: `金库可用余额不足以落锁（${spec.side} 需锁 ${obligationToken}）`,
        obligation: obligation.toString(),
        available: available.toString(),
      })
      continue
    }
    const cursorKey = `${chainId}:${w.address.toLowerCase()}`
    if (!nonceCursor.has(cursorKey)) {
      nonceCursor.set(cursorKey, await currentNonce(chainId, w.address))
    }
    const nonce = nonceCursor.get(cursorKey)!
    nonceCursor.set(cursorKey, nonce + 1)

    const createdAt = Math.floor(Date.now() / 1000)
    const expiresAt = createdAt + (spec.ttlSec ?? 3600)
    orderSeq += 1
    const raw: RawOrder = {
      orderId: `soak_${chainId}_${Date.now()}_${orderSeq}`,
      trader: w.address,
      pair: spec.pair,
      side: spec.side,
      price: price.toString(),
      amount: amountIn.toString(),
      filled: '0',
      status: 'open',
      nonce,
      createdAt,
      expiresAt,
      signature: '',
      execType: spec.execType,
    }
    const data = buildSignedOrderData(raw, chainId)
    if (!data) {
      skipped.push({ spec, reason: '签名订单重构失败（金额/价格非法）' })
      continue
    }
    const message = {
      orderId: data.orderId,
      userAddress: data.userAddress,
      tokenIn: data.tokenIn,
      tokenOut: data.tokenOut,
      amountIn: data.amountIn,
      amountOut: data.amountOut,
      price: data.price,
      timestamp: data.timestamp,
      expiresAt: data.expiresAt,
      nonce: data.nonce,
      side: data.side,
    } satisfies OrderData
    raw.signature = await w.wallet.signTypedData(
      getEIP712Domain(chainId) as ethers.TypedDataDomain,
      ORDER_TYPES as unknown as Record<string, ethers.TypedDataField[]>,
      message,
    )
    const body: Record<string, unknown> = {
      orderId: raw.orderId,
      trader: raw.trader,
      pair: raw.pair,
      side: raw.side,
      price: raw.price,
      amount: raw.amount,
      filled: '0',
      status: 'open',
      nonce: raw.nonce,
      createdAt: raw.createdAt,
      expiresAt: raw.expiresAt,
      signature: raw.signature,
      ...(spec.execType ? { execType: spec.execType } : {}),
    }
    generated.push({
      chainId,
      digest: computeOrderDigest(data, chainId),
      role: spec.role,
      pair: spec.pair,
      side: spec.side,
      body,
      createdAt,
    })
  }
  return { generated, skipped }
}

export interface SubmitOutcome {
  node: boolean
  relay: boolean
  nodeError?: string
  relayError?: string
  /**
   * 本单真正发起网络提交的时刻（ms，第 36 轮 N4）：在 submitOrder
   * 入口、首个 fetch 之前打点。旧口径由 recordSubmitted 在整批提交
   * 完成后统一打点，批次内越靠前的单其传播延迟被系统性低估越多。
   */
  submittedAt: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 双发一单：节点 POST /api/order（主）、中继 POST /orders（副，带 chainId）。
 * relaySideOverride（对抗场景专用）：向中继投递 side 被改写的同一签名
 * 订单；节点只收正本。
 * 阶段 3 前（side 未签名）：改写副本与正本同 digest，中继先到先得、
 * 双读判冲突/未知（第 35 轮 D2 的验证手段）。
 * 阶段 3 后（side 进签名）：改写副本的 digest 已变、中继在入库验签处
 * 直接拒绝（400），节点正本不受影响、双读判 VALID——本场景自切换起
 * 改测「中继入库验签拦截篡改」，账本仍按 tampered 单独计数、不进有效
 * 样本口径（与 report.mjs 一致），压测中低频使用。
 */
export async function submitOrder(
  nodeUrl: string,
  relayUrl: string,
  gen: GeneratedOrder,
  relaySideOverride?: 'buy' | 'sell',
): Promise<SubmitOutcome> {
  // N4：第 36 轮起在真正发起提交的入口打点，而不是批次结束后补记。
  const out: SubmitOutcome = { node: false, relay: false, submittedAt: Date.now() }
  const relayBody = {
    ...gen.body,
    chainId: gen.chainId,
    ...(relaySideOverride ? { side: relaySideOverride } : {}),
  }
  if (relaySideOverride) {
    // 先把改写副本送到中继（占住 digest），再给节点送正本
    try {
      const res = await fetch(`${relayUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(relayBody),
      })
      out.relay = res.ok
      if (!res.ok) out.relayError = `http ${res.status}: ${(await res.text()).slice(0, 120)}`
    } catch (e) {
      out.relayError = e instanceof Error ? e.message : String(e)
    }
  }
  try {
    const res = await fetch(`${nodeUrl}/api/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(gen.body),
    })
    out.node = res.ok
    if (!res.ok) out.nodeError = `http ${res.status}: ${(await res.text()).slice(0, 120)}`
  } catch (e) {
    out.nodeError = e instanceof Error ? e.message : String(e)
  }
  if (!relaySideOverride) {
    try {
      const res = await fetch(`${relayUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(relayBody),
      })
      out.relay = res.ok
      if (!res.ok) out.relayError = `http ${res.status}: ${(await res.text()).slice(0, 120)}`
    } catch (e) {
      out.relayError = e instanceof Error ? e.message : String(e)
    }
  }
  return out
}

/** 批量双发（逐单间隔限速）；tamperDigests 内的订单走 side 改写注入 */
export async function submitBatch(
  nodeUrl: string,
  relayUrl: string,
  orders: GeneratedOrder[],
  gapMs = 2000,
  tamperDigests: Set<string> = new Set(),
): Promise<Array<{ gen: GeneratedOrder; outcome: SubmitOutcome }>> {
  const results: Array<{ gen: GeneratedOrder; outcome: SubmitOutcome }> = []
  for (const gen of orders) {
    const tamper = tamperDigests.has(gen.digest.toLowerCase())
      ? gen.side === 'buy'
        ? ('sell' as const)
        : ('buy' as const)
      : undefined
    results.push({ gen, outcome: await submitOrder(nodeUrl, relayUrl, gen, tamper) })
    if (gapMs > 0) await sleep(gapMs)
  }
  return results
}
