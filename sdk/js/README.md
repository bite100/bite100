# P2P DEX JavaScript/TypeScript SDK

P2P DEX 的官方 JavaScript/TypeScript SDK，提供与节点 API 交互和订单签名的便捷方法。

## 安装

```bash
npm install @p2p-dex/sdk
# 或
yarn add @p2p-dex/sdk
```

## 快速开始

### 1. 初始化客户端

```typescript
import { NodeAPIClient } from '@p2p-dex/sdk'

const client = new NodeAPIClient({
  baseUrl: 'http://localhost:8080',
  timeout: 10000, // 可选，默认 10 秒
})
```

### 2. 查询订单簿

```typescript
const orderbook = await client.getOrderbook('TKA/TKB')
console.log('买盘:', orderbook.bids)
console.log('卖盘:', orderbook.asks)
```

### 3. 查询成交记录

```typescript
const trades = await client.getTrades({
  pair: 'TKA/TKB',
  limit: 50,
  since: Date.now() / 1000 - 3600, // 最近 1 小时
})
```

### 4. 创建并提交订单

```typescript
import { ethers } from 'ethers'
import { createSignedOrder, NodeAPIClient } from '@p2p-dex/sdk'

// 连接钱包
const provider = new ethers.BrowserProvider(window.ethereum)
const signer = await provider.getSigner()

// 创建签名订单
const order = await createSignedOrder(
  signer,
  'TKA/TKB',
  'buy',
  ethers.parseEther('1.5').toString(),
  ethers.parseEther('100').toString(),
  '0x678195277dc8F84F787A4694DF42F3489eA757bf', // tokenIn (TKA)
  '0x9Be241a0bF1C2827194333B57278d1676494333a', // tokenOut (TKB)
  1, // nonce
  7 // expiresInDays
)

// 提交订单
const client = new NodeAPIClient({ baseUrl: 'http://localhost:8080' })
const result = await client.placeOrder(order)
console.log('订单已提交:', result.orderId)
```

### 5. 取消订单

```typescript
import { OrderSigner } from '@p2p-dex/sdk'

const orderSigner = new OrderSigner(signer)
const timestamp = Math.floor(Date.now() / 1000)
const signature = await orderSigner.signCancelOrder(
  orderId,
  await signer.getAddress(),
  timestamp
)

await client.cancelOrder(orderId, signature, timestamp)
```

## API 参考

### NodeAPIClient

#### `getOrderbook(pair: string): Promise<OrderbookResponse>`

查询指定交易对的订单簿。

#### `getTrades(params?): Promise<Trade[]>`

查询成交记录。

参数：
- `pair?`: 交易对过滤
- `limit?`: 返回数量限制（默认 50，最大 200）
- `since?`: 起始时间戳（Unix 秒）
- `until?`: 结束时间戳（Unix 秒）

#### `getMyOrders(params?): Promise<Order[]>`

查询我的订单。

参数：
- `trader?`: 交易者地址
- `pair?`: 交易对过滤
- `limit?`: 返回数量限制

#### `placeOrder(order: Order): Promise<{ok: boolean, orderId: string}>`

提交订单。

#### `cancelOrder(orderId: string, signature?: string, timestamp?: number): Promise<{ok: boolean}>`

取消订单。

#### `getNodeInfo(): Promise<{type: string, peerId?: string}>`

查询节点信息。

### OrderSigner

#### `signOrder(order, tokenIn, tokenOut): Promise<string>`

使用 EIP-712 签名订单。

#### `signCancelOrder(orderId, userAddress, timestamp): Promise<string>`

使用 EIP-712 签名取消订单。

#### `generateOrderId(...): string`

生成订单 ID。

## 类型定义

```typescript
interface Order {
  orderId: string
  trader: string
  pair: string
  side: 'buy' | 'sell'
  price: string
  amount: string
  filled?: string
  status?: string
  nonce: number
  createdAt: number
  expiresAt: number
  signature?: string
}

interface Trade {
  tradeId: string
  pair: string
  makerOrderID?: string
  takerOrderID?: string
  maker?: string
  taker?: string
  tokenIn?: string
  tokenOut?: string
  amountIn?: string
  amountOut?: string
  price: string
  amount: string
  timestamp: number
  txHash?: string
}
```

## 示例

完整示例见 [examples/](./examples/) 目录。

## 许可证

MIT
