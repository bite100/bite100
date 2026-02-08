import { ethers } from 'ethers'

/**
 * P2P DEX SDK - JavaScript/TypeScript SDK for P2P DEX
 */

export interface Order {
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

export interface Trade {
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

export interface OrderbookResponse {
  pair: string
  bids: Order[]
  asks: Order[]
}

export interface NodeAPIConfig {
  baseUrl: string
  timeout?: number
}

/**
 * Node API Client - 与 P2P DEX 节点 HTTP API 交互
 */
export class NodeAPIClient {
  private baseUrl: string
  private timeout: number

  constructor(config: NodeAPIConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.timeout = config.timeout || 10000
  }

  private async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers,
        },
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: response.statusText }))
        throw new Error(error.error || `HTTP ${response.status}`)
      }

      return await response.json()
    } catch (error) {
      clearTimeout(timeoutId)
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Request timeout')
      }
      throw error
    }
  }

  /**
   * 查询订单簿
   */
  async getOrderbook(pair: string): Promise<OrderbookResponse> {
    return this.request<OrderbookResponse>(`/api/orderbook?pair=${encodeURIComponent(pair)}`)
  }

  /**
   * 查询成交记录
   */
  async getTrades(params?: {
    pair?: string
    limit?: number
    since?: number
    until?: number
  }): Promise<Trade[]> {
    const query = new URLSearchParams()
    if (params?.pair) query.append('pair', params.pair)
    if (params?.limit) query.append('limit', params.limit.toString())
    if (params?.since) query.append('since', params.since.toString())
    if (params?.until) query.append('until', params.until.toString())

    return this.request<Trade[]>(`/api/trades?${query.toString()}`)
  }

  /**
   * 查询我的订单
   */
  async getMyOrders(params?: {
    trader?: string
    pair?: string
    limit?: number
  }): Promise<Order[]> {
    const query = new URLSearchParams()
    if (params?.trader) query.append('trader', params.trader)
    if (params?.pair) query.append('pair', params.pair)
    if (params?.limit) query.append('limit', params.limit.toString())

    return this.request<Order[]>(`/api/orders?${query.toString()}`)
  }

  /**
   * 提交订单
   */
  async placeOrder(order: Order): Promise<{ ok: boolean; orderId: string }> {
    return this.request<{ ok: boolean; orderId: string }>('/api/order', {
      method: 'POST',
      body: JSON.stringify(order),
    })
  }

  /**
   * 取消订单
   */
  async cancelOrder(orderId: string, signature?: string, timestamp?: number): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('/api/order/cancel', {
      method: 'POST',
      body: JSON.stringify({
        orderId,
        signature,
        timestamp: timestamp || Math.floor(Date.now() / 1000),
      }),
    })
  }

  /**
   * 查询节点信息
   */
  async getNodeInfo(): Promise<{ type: string; peerId?: string }> {
    return this.request<{ type: string; peerId?: string }>('/api/node')
  }
}

/**
 * Order Signer - EIP-712 订单签名工具
 */
export class OrderSigner {
  private signer: ethers.Signer
  private chainId: number

  constructor(signer: ethers.Signer, chainId: number = 11155111) {
    this.signer = signer
    this.chainId = chainId
  }

  /**
   * 生成订单 ID
   */
  generateOrderId(
    trader: string,
    nonce: number,
    pair: string,
    price: string,
    amount: string,
    timestamp: number
  ): string {
    const data = ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'uint256', 'string', 'string', 'string', 'uint256'],
      [trader, nonce, pair, price, amount, timestamp]
    )
    return ethers.keccak256(data)
  }

  /**
   * 签名订单（EIP-712）
   */
  async signOrder(
    order: Omit<Order, 'signature'>,
    tokenIn: string,
    tokenOut: string
  ): Promise<string> {
    const domain = {
      name: 'P2P DEX',
      version: '1',
      chainId: this.chainId,
    }

    const types = {
      Order: [
        { name: 'orderId', type: 'string' },
        { name: 'userAddress', type: 'address' },
        { name: 'tokenIn', type: 'address' },
        { name: 'tokenOut', type: 'address' },
        { name: 'amountIn', type: 'uint256' },
        { name: 'amountOut', type: 'uint256' },
        { name: 'price', type: 'uint256' },
        { name: 'timestamp', type: 'uint256' },
        { name: 'expiresAt', type: 'uint256' },
      ],
    }

    // 计算 amountOut = amountIn * price
    const amountIn = BigInt(order.amount)
    const price = BigInt(order.price)
    const amountOut = amountIn * price

    const value = {
      orderId: order.orderId,
      userAddress: order.trader,
      tokenIn,
      tokenOut,
      amountIn: order.amount,
      amountOut: amountOut.toString(),
      price: order.price,
      timestamp: order.createdAt.toString(),
      expiresAt: order.expiresAt.toString(),
    }

    return await this.signer.signTypedData(domain, types, value)
  }

  /**
   * 签名取消订单（EIP-712）
   */
  async signCancelOrder(orderId: string, userAddress: string, timestamp: number): Promise<string> {
    const domain = {
      name: 'P2P DEX',
      version: '1',
      chainId: this.chainId,
    }

    const types = {
      CancelOrder: [
        { name: 'orderId', type: 'string' },
        { name: 'userAddress', type: 'address' },
        { name: 'timestamp', type: 'uint256' },
      ],
    }

    const value = {
      orderId,
      userAddress,
      timestamp: timestamp.toString(),
    }

    return await this.signer.signTypedData(domain, types, value)
  }
}

/**
 * 创建订单并签名
 */
export async function createSignedOrder(
  signer: ethers.Signer,
  pair: string,
  side: 'buy' | 'sell',
  price: string,
  amount: string,
  tokenIn: string,
  tokenOut: string,
  nonce: number,
  expiresInDays: number = 7
): Promise<Order> {
  const trader = await signer.getAddress()
  const createdAt = Math.floor(Date.now() / 1000)
  const expiresAt = createdAt + expiresInDays * 24 * 3600

  const orderSigner = new OrderSigner(signer)
  const orderId = orderSigner.generateOrderId(trader, nonce, pair, price, amount, createdAt)

  const order: Omit<Order, 'signature'> = {
    orderId,
    trader,
    pair,
    side,
    price,
    amount,
    nonce,
    createdAt,
    expiresAt,
  }

  const signature = await orderSigner.signOrder(order, tokenIn, tokenOut)

  return {
    ...order,
    signature,
  }
}
