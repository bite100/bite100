/**
 * P2P DEX SDK 基础使用示例
 */

import { ethers } from 'ethers'
import { NodeAPIClient, createSignedOrder, OrderSigner } from '../src/index'

async function main() {
  // 1. 初始化客户端
  const client = new NodeAPIClient({
    baseUrl: 'http://localhost:8080',
  })

  // 2. 查询订单簿
  console.log('查询订单簿...')
  const orderbook = await client.getOrderbook('TKA/TKB')
  console.log('买盘数量:', orderbook.bids.length)
  console.log('卖盘数量:', orderbook.asks.length)

  // 3. 查询成交记录
  console.log('\n查询成交记录...')
  const trades = await client.getTrades({
    pair: 'TKA/TKB',
    limit: 10,
  })
  console.log('最近成交:', trades.length, '笔')

  // 4. 连接钱包（浏览器环境）
  if (typeof window !== 'undefined' && window.ethereum) {
    const provider = new ethers.BrowserProvider(window.ethereum)
    const signer = await provider.getSigner()
    const address = await signer.getAddress()
    console.log('\n已连接钱包:', address)

    // 5. 创建并提交订单
    console.log('\n创建订单...')
    const order = await createSignedOrder(
      signer,
      'TKA/TKB',
      'buy',
      ethers.parseEther('1.5').toString(),
      ethers.parseEther('100').toString(),
      '0x678195277dc8F84F787A4694DF42F3489eA757bf', // TKA
      '0x9Be241a0bF1C2827194333B57278d1676494333a', // TKB
      1,
      7
    )

    console.log('订单 ID:', order.orderId)
    console.log('订单签名:', order.signature?.slice(0, 20) + '...')

    // 提交订单
    const result = await client.placeOrder(order)
    console.log('订单提交结果:', result)

    // 6. 查询我的订单
    console.log('\n查询我的订单...')
    const myOrders = await client.getMyOrders({
      trader: address,
      pair: 'TKA/TKB',
    })
    console.log('我的订单数量:', myOrders.length)

    // 7. 取消订单示例
    if (myOrders.length > 0) {
      const orderToCancel = myOrders[0]
      console.log('\n取消订单:', orderToCancel.orderId)

      const orderSigner = new OrderSigner(signer)
      const timestamp = Math.floor(Date.now() / 1000)
      const cancelSignature = await orderSigner.signCancelOrder(
        orderToCancel.orderId,
        address,
        timestamp
      )

      const cancelResult = await client.cancelOrder(
        orderToCancel.orderId,
        cancelSignature,
        timestamp
      )
      console.log('取消结果:', cancelResult)
    }
  } else {
    console.log('\n未检测到钱包，跳过订单操作')
  }
}

// 运行示例
if (require.main === module) {
  main().catch(console.error)
}

export { main }
