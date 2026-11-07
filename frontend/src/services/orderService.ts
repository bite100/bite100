import { ethers } from 'ethers'
import { CHAIN_ID } from '../config'
import { nodePost } from '../nodeClient'
import { signOrder, signCancelOrder, generateOrderId, fetchOrderNonce, OrderData } from './orderSigning'

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
  }

  // 签名订单（域按当前链生成）
  const signature = await signOrder(orderData, signer, CHAIN_ID)

  // 提交到 P2P 节点（nonce/expiresAt 必须随单提交，节点按签名原文重建验签）
  await nodePost('/api/order', {
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
  })
  
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
