/**
 * 订单构建+签名（place 与 match 共用）：全部骑前端生产代码——
 * dualread/digest.buildSignedOrderData 按交易所规范从原始字段重构
 * 签名数据（与 soak 生成器、阶段 4 运行器同一条路径），
 * orderSigning.fetchOrderNonce 取链上 Settlement nonce，
 * 签名走 EIP-712 域/类型且只经 AgentSigner 接口（signers.ts）。
 */
import { ethers } from 'ethers'
import { z } from 'zod'
import { assertAllowedChain, assertAllowedPair, pairTokens } from '../config'
import { ToolError } from '../errors'
import { loadSignerForRole } from '../signers'
import { chainIdField, type ToolContext } from './common'

// —— 前端生产代码（相对路径深导入，与 indexer 骑前端配置同法）——
import { buildSignedOrderData, computeOrderDigest } from '../../../frontend/src/services/dualread/digest'
import { fetchOrderNonce } from '../../../frontend/src/services/orderSigning'
import { getEIP712Domain, ORDER_TYPES, type OrderData } from '../../../frontend/src/services/orderSigningTypes'
import type { RawOrder } from '../../../frontend/src/services/dualread/types'

let orderSeq = 0

export const humanAmount = z
  .string()
  .regex(/^\d+(\.\d+)?$/, '必须是十进制数字字符串')
  .refine((v) => Number(v) > 0, '必须大于 0')

export const placeOrderSchema = z.object({
  chainId: chainIdField,
  pair: z.string().min(3),
  side: z.enum(['buy', 'sell']),
  /** 限价（计价代币/基础代币，人类单位十进制字符串，如 "1.5"） */
  price: humanAmount,
  /** 数量（基础代币人类单位，如 "0.5"） */
  amount: humanAmount,
  ttlSeconds: z.number().int().min(60).max(86_400).optional(),
})

export interface BuiltOrder {
  data: OrderData
  signature: string
  digest: string
  body: Record<string, unknown>
  notionalQuote: number
}

/** 构建 + 签名一单（不投递） */
export async function buildAndSign(
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

/**
 * 投递 + 结果不确定时先对账（第 59 轮审查修复批 P1；place/match 共用）。
 *
 * 中继 postOrder 只在 fetch 本身抛错（网络断/超时/响应丢失）时抛错——
 * 这是「结果不确定」：请求可能已被中继处理入库、只是响应没回来。
 * 旧实现把抛错一律当投递失败并 release 每日预留，于是簿上活单零成本
 * （预留被退、订单照样能成交）。修法按结果确定性分三路：
 *  (a) 明确 HTTP 非 200：中继明确未接受 → release 后抛 relay_rejected；
 *  (b) 抛错：先按 digest 向中继精确对账（getOrderByDigest 骑中继
 *      GET /orders 的 digest 精确匹配参数——微修复批起；旧实现骑
 *      listOrders 列表扫描，同对订单超 200 时目标单会被截断在列表
 *      外、对账误判未入库，截断竞态已从根上消除）：
 *      - 查到 = 已入库：不 release（预留转为正式记账），返回
 *        { reconciled: true }，调用方按已接受继续；
 *      - 确认未入库：release 后原样抛投递错误；
 *  (c) 对账本身失败：fail-closed——不 release（宁可占住预留也不放行
 *      零成本活单），抛 delivery_ambiguous 让调用方明确知道本单状态
 *      未定、预留未退，应先查 list_orders 再决定是否重下。
 * 构造/签名阶段的失败不经本函数（中继从未被接触），由调用方直接
 * release，口径不变。
 */
export async function deliverOrder(
  ctx: ToolContext,
  built: BuiltOrder,
  release: () => void | Promise<void>,
): Promise<{ reconciled: boolean }> {
  let res: { status: number; text: string }
  try {
    res = await ctx.relay.postOrder(built.body)
  } catch (postErr) {
    let found: boolean
    try {
      const hit = await ctx.relay.getOrderByDigest({
        chainId: Number(built.body.chainId),
        digest: built.digest,
      })
      found = hit !== null
    } catch {
      throw new ToolError(
        'delivery_ambiguous',
        `订单投递结果不确定且向中继对账失败（摘要 ${built.digest}）：中继可能已入库本单，每日额度预留未退还。请先用 list_orders 核对该摘要是否在簿，确认不在簿前不要重下同单。`,
      )
    }
    if (!found) {
      await release()
      throw postErr
    }
    return { reconciled: true }
  }
  if (res.status !== 200) {
    await release()
    throw new ToolError('relay_rejected', `中继拒单 HTTP ${res.status}: ${res.text}`)
  }
  return { reconciled: false }
}
