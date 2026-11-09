/**
 * 块 2/3：写工具。全部先过服务端护栏（WriteGuard），签名只经
 * AgentSigner 接口（本轮实现 = 服务端测试钱包签名器，见 signers.ts）。
 *
 * 骑乘关系：
 * - 订单构建/摘要：前端生产代码 dualread/digest 的 buildSignedOrderData
 *   + computeOrderDigest（与 soak 生成器、阶段 4 运行器同一条路径）；
 * - nonce：orderSigning.fetchOrderNonce（链上 Settlement.getCurrentNonce）；
 * - 签名：EIP-712（orderSigningTypes 的域与 ORDER_TYPES）；
 * - 投递：中继 REST POST /orders（中继入库时自带验签）；
 * - 硬撤：Vault.releaseOrderLock（第 46/47 轮语义）。
 * 撮合结算工具在 tools/match.ts（块 3）。
 */
import { ethers } from 'ethers'
import { z } from 'zod'
import { assertAllowedChain, assertAllowedPair, chainConfig, pairTokens } from '../config'
import { loadSignerForRole } from '../signers'
import { ToolError } from '../errors'
import { chainIdField, digestField, parseArgs, type ToolContext, type ToolDef } from './common'

// —— 前端生产代码（相对路径深导入，与 indexer 骑前端配置同法）——
import { buildSignedOrderData, computeOrderDigest } from '../../../frontend/src/services/dualread/digest'
import { fetchOrderNonce } from '../../../frontend/src/services/orderSigning'
import { getEIP712Domain, ORDER_TYPES, type OrderData } from '../../../frontend/src/services/orderSigningTypes'
import type { RawOrder } from '../../../frontend/src/services/dualread/types'

const VAULT_CANCEL_ABI = [
  'function lockers(address) view returns (bool)',
  'function releaseOrderLock(bytes32)',
]

let orderSeq = 0

const humanAmount = z
  .string()
  .regex(/^\d+(\.\d+)?$/, '必须是十进制数字字符串')
  .refine((v) => Number(v) > 0, '必须大于 0')

const placeOrderSchema = z.object({
  chainId: chainIdField,
  pair: z.string().min(3),
  side: z.enum(['buy', 'sell']),
  /** 限价（计价代币/基础代币，人类单位十进制字符串，如 "1.5"） */
  price: humanAmount,
  /** 数量（基础代币人类单位，如 "0.5"） */
  amount: humanAmount,
  ttlSeconds: z.number().int().min(60).max(86_400).optional(),
})

const hardCancelSchema = z.object({
  chainId: chainIdField,
  digest: digestField,
})

interface BuiltOrder {
  data: OrderData
  signature: string
  digest: string
  body: Record<string, unknown>
  notionalQuote: number
}

/** 构建 + 签名一单（不投递）：place 与 match 共用 */
async function buildAndSign(
  ctx: ToolContext,
  input: z.infer<typeof placeOrderSchema>,
): Promise<BuiltOrder> {
  const { chainId, pair, side, price, amount } = input
  assertAllowedChain(chainId)
  assertAllowedPair(pair)
  pairTokens(chainId, pair) // 未登记代币对在此失败关闭

  const signer = loadSignerForRole(ctx.agent.role)
  const provider = ctx.chain.provider(chainId)
  const nonce = await fetchOrderNonce(signer.address, provider, chainId)

  const now = Math.floor(Date.now() / 1000)
  const raw: RawOrder = {
    orderId: `mcp_${chainId}_${now}_${++orderSeq}`,
    trader: signer.address,
    pair,
    side,
    price: ethers.parseUnits(price, 18).toString(),
    amount: ethers.parseUnits(amount, 18).toString(),
    filled: '0',
    status: 'open',
    nonce,
    createdAt: now,
    expiresAt: now + (input.ttlSeconds ?? 3600),
    signature: '',
    execType: 'limit',
  }
  const data = buildSignedOrderData(raw, chainId)
  if (!data) throw new ToolError('order_unbuildable', '订单无法构建（价格/数量按规范公式换算后非法）')
  const signature = await signer.signTypedData(
    getEIP712Domain(chainId) as ethers.TypedDataDomain,
    ORDER_TYPES as unknown as Record<string, ethers.TypedDataField[]>,
    data as unknown as Record<string, unknown>,
  )
  const digest = computeOrderDigest(data, chainId)
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
    signature,
    execType: 'limit',
    chainId,
  }
  return { data, signature, digest, body, notionalQuote: Number(price) * Number(amount) }
}

export const writeTools: ToolDef[] = [
  {
    name: 'place_order',
    description:
      '挂一单限价单：服务端用本 agent 钱包角色的测试钱包按交易所规范构建并 EIP-712 签名，投递到中继订单簿。先过护栏（身份启用/急停/链与交易对白名单/单笔与每日限额/频率）。订单此时未落锁——与网页端流程一致，落锁在撮合结算时由提交方经 Vault 完成。',
    schema: placeOrderSchema,
    write: true,
    handler: async (ctx, args) => {
      const input = parseArgs(placeOrderSchema, args)
      // 护栏先行：白名单与限额在构建/签名之前判定，拒绝不产生任何链上/中继副作用
      assertAllowedChain(input.chainId)
      assertAllowedPair(input.pair)
      const notional = Number(input.price) * Number(input.amount)
      ctx.guard.check(ctx.agent, notional)

      const built = await buildAndSign(ctx, input)
      const res = await ctx.relay.postOrder(built.body)
      if (res.status !== 200) {
        throw new ToolError('relay_rejected', `中继拒单 HTTP ${res.status}: ${res.text}`)
      }
      ctx.guard.record(ctx.agent, notional)
      return {
        orderId: built.data.orderId,
        digest: built.digest,
        chainId: input.chainId,
        pair: input.pair,
        side: input.side,
        price: input.price,
        amount: input.amount,
        expiresAt: built.data.expiresAt,
        relayStatus: res.status,
        note: '订单已挂入中继订单簿（未落锁）；被撮合时由结算提交方落锁并结算。',
      }
    },
  },
  {
    name: 'hard_cancel_order',
    description:
      '链上硬撤（永久作废）：对一单已落锁的订单调 Vault.releaseOrderLock，释放锁定并置第 47 轮撤单墓碑，该单此后不可再被落锁或结算。仅 locker 身份可执行（当前测试栈里只有 operator/部署者角色是 locker）；未落锁的订单没有链上可撤对象——中继无撤单路由、节点已停机，这类订单只能等过期或被成交，本工具会如实返回该缺口而不是假装撤掉。',
    schema: hardCancelSchema,
    write: true,
    handler: async (ctx, args) => {
      const { chainId, digest } = parseArgs(hardCancelSchema, args)
      assertAllowedChain(chainId)
      ctx.guard.check(ctx.agent, 0) // 急停/停用对撤单同样生效

      if (await ctx.chain.orderCancelled(chainId, digest)) {
        return { chainId, digest, cancelled: true, alreadyCancelled: true }
      }
      const lock = await ctx.chain.orderLock(chainId, digest)
      if (!lock) {
        return {
          chainId,
          digest,
          cancelled: false,
          reason: 'no_active_lock',
          explanation:
            '该订单当前没有链上锁定（未被撮合落锁或锁已释放/过期）。中继没有撤单路由、节点已停机，未落锁订单不存在链上硬撤对象：只能等待订单过期或被成交。这是当前撤单面的真实缺口，本工具不会假装已撤销。',
        }
      }
      const signer = loadSignerForRole(ctx.agent.role)
      const provider = ctx.chain.provider(chainId)
      const { vault } = chainConfig(chainId).contracts
      const vaultRead = new ethers.Contract(vault, VAULT_CANCEL_ABI, provider)
      const isLocker: boolean = await vaultRead.lockers(signer.address)
      if (!isLocker) {
        throw new ToolError(
          'not_locker',
          `agent 角色 ${ctx.agent.role} 的钱包不是 Vault locker，无法执行链上硬撤。当前测试栈只有 operator（部署者）是 locker；maker/taker 的已锁定订单只能等锁过期释放或被结算。如需紧急撤单，请用 operator 身份调用本工具。`,
        )
      }
      const vaultWrite = new ethers.Contract(vault, VAULT_CANCEL_ABI, signer.connect(provider))
      const tx = await vaultWrite.releaseOrderLock(digest)
      const receipt = await tx.wait()
      const cancelled = await ctx.chain.orderCancelled(chainId, digest)
      ctx.guard.record(ctx.agent, 0)
      return {
        chainId,
        digest,
        cancelled,
        txHash: receipt?.hash ?? tx.hash,
        releasedLock: lock,
      }
    },
  },
]
