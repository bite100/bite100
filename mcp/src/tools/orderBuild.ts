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
