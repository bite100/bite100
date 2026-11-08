import { ethers } from 'ethers'
import { CHAIN_ID } from '../config'
import { nodePost } from '../nodeClient'
import { dualSendOrderToRelay } from './relayDualSend'
import { signOrder, signCancelOrder, generateOrderId, fetchOrderNonce, OrderData } from './orderSigning'
import { sideToSignedValue } from './orderSigningTypes'

/** 双通道广播结果：哪条通道接了单；两条都失败时 nodeError 带节点侧原始错误。 */
export interface OrderBroadcastOutcome {
  viaNode: boolean
  viaRelay: boolean
  nodeError?: unknown
}

/**
 * 订单双通道广播（无节点化阶段 4）：同一份订单原文**并行**投递节点
 * （POST /api/order）与公告栏中继（dualSendOrderToRelay，POST /orders），
 * 任一通道接单即广播成功——节点停机时订单照样进中继簿供前端撮合消费。
 * 签名/验签/去重语义与单通道时代完全一致：两边收到的都是同一份原文，
 * 中继按 EIP-712 digest 去重、节点按 orderId 去重。本函数不抛错，
 * 双失败的抛错口径由调用方决定。
 */
export async function broadcastOrderDualChannel(
  orderBody: Record<string, unknown>,
  chainId: number,
): Promise<OrderBroadcastOutcome> {
  const [node, viaRelay] = await Promise.all([
    nodePost('/api/order', orderBody).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    dualSendOrderToRelay(orderBody, chainId),
  ])
  return node.ok
    ? { viaNode: true, viaRelay }
    : { viaNode: false, viaRelay, nodeError: node.error }
}

export interface OrderParams {
  tokenIn: string
  tokenOut: string
  amountIn: string
  amountOut: string
  price: string
  side: 'buy' | 'sell'
  type: 'limit' | 'market'
  pair: string
}

export async function submitOrder(
  params: OrderParams,
  signer: ethers.Signer
): Promise<string> {
  const address = await signer.getAddress()
  const timestamp = Math.floor(Date.now() / 1000)
  const expiresAt = timestamp + 86400 // 24 小时后过期
  
  const orderId = generateOrderId()

  // 统一规范：签名必须带链上结算 nonce（结算时被合约消耗）
  const nonce = await fetchOrderNonce(address, signer, CHAIN_ID)

  // 构造订单数据
  const orderData: OrderData = {
    orderId,
    userAddress: address,
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: ethers.parseUnits(params.amountIn, 18).toString(),
    amountOut: ethers.parseUnits(params.amountOut, 18).toString(),
    price: ethers.parseUnits(params.price, 18).toString(),
    timestamp,
    expiresAt,
    nonce,
    side: sideToSignedValue(params.side),
  }

  // 签名订单（域按当前链生成）
  const signature = await signOrder(orderData, signer, CHAIN_ID)

  // 提交到 P2P 节点（nonce/expiresAt 必须随单提交，节点按签名原文重建验签）
  const orderBody = {
    orderId,
    trader: address,
    pair: params.pair,
    side: params.side,
    price: params.price,
    amount: params.amountIn,
    filled: '0',
    status: 'open',
    createdAt: timestamp,
    expiresAt,
    nonce,
    signature,
  }
  // 双通道并行广播：任一通道接单即下单成功；双通道都失败才失败，
  // 抛出节点侧原始错误（保持既有错误面貌）。
  const broadcast = await broadcastOrderDualChannel(orderBody, CHAIN_ID)
  if (!broadcast.viaNode && !broadcast.viaRelay) {
    throw broadcast.nodeError instanceof Error
      ? broadcast.nodeError
      : new Error('订单广播失败：节点与中继通道均未接单')
  }

  return orderId
}

export async function cancelOrder(
  orderID: string,
  signer: ethers.Signer
): Promise<void> {
  const address = await signer.getAddress()
  const timestamp = Math.floor(Date.now() / 1000)
  
  const signature = await signCancelOrder(orderID, address, timestamp, signer, CHAIN_ID)
  
  await nodePost('/api/order/cancel', {
    orderId: orderID,
    signature,
  })
}
