import { ethers } from 'ethers'
import { nodePost } from '../nodeClient'
import { signOrder, signCancelOrder, generateOrderId, OrderData } from './orderSigning'

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
  }
  
  // 签名订单
  const signature = await signOrder(orderData, signer)
  
  // 提交到 P2P 节点
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
  
  const signature = await signCancelOrder(orderID, address, timestamp, signer)
  
  await nodePost('/api/order/cancel', {
    orderId: orderID,
    signature,
  })
}
