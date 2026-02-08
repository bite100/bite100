import React, { useState } from 'react'
import { ethers } from 'ethers'
import { useP2P } from '../contexts/P2PContext'
import { signOrder, generateOrderId } from '../services/orderSigning'
import './OrderForm.css'

interface OrderFormProps {
  pair: string
  onSuccess?: () => void
}

export function OrderForm({ pair, onSuccess }: OrderFormProps) {
  const { publishOrder, isConnected } = useP2P()
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [price, setPrice] = useState('')
  const [amount, setAmount] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!price || !amount) {
      alert('请输入价格和数量')
      return
    }

    if (!isConnected) {
      alert('P2P 节点未连接，请稍候')
      return
    }

    try {
      setLoading(true)
      
      // 获取 signer
      if (!window.ethereum) {
        alert('请安装 MetaMask')
        return
      }

      const provider = new ethers.providers.Web3Provider(window.ethereum)
      await provider.send('eth_requestAccounts', [])
      const signer = provider.getSigner()
      const address = await signer.getAddress()
      
      // 生成订单 ID
      const orderId = generateOrderId()
      const timestamp = Math.floor(Date.now() / 1000)
      
      // 构造订单数据
      const orderData = {
        orderId,
        userAddress: address,
        tokenIn: '', // TODO: 从 pair 解析
        tokenOut: '',
        amountIn: ethers.utils.parseUnits(amount, 18).toString(),
        amountOut: '0',
        price: ethers.utils.parseUnits(price, 18).toString(),
        timestamp,
        expiresAt: timestamp + 86400, // 24 小时
      }
      
      // 签名
      const signature = await signOrder(orderData, signer)
      
      // 发布到 P2P 网络
      await publishOrder({
        orderId,
        trader: address,
        pair,
        side,
        price,
        amount,
        timestamp,
        signature,
      })
      
      alert('订单已提交到 P2P 网络')
      setPrice('')
      setAmount('')
      onSuccess?.()
    } catch (error) {
      console.error('提交订单失败:', error)
      alert('提交订单失败: ' + (error as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <form className="order-form" onSubmit={handleSubmit}>
      <h3>下单 - {pair}</h3>
      
      <div className="side-selector">
        <button
          type="button"
          className={`side-btn ${side === 'buy' ? 'active buy' : ''}`}
          onClick={() => setSide('buy')}
        >
          买入
        </button>
        <button
          type="button"
          className={`side-btn ${side === 'sell' ? 'active sell' : ''}`}
          onClick={() => setSide('sell')}
        >
          卖出
        </button>
      </div>
      
      <div className="form-group">
        <label>价格</label>
        <input
          type="number"
          step="0.000001"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="0.00"
          required
        />
      </div>
      
      <div className="form-group">
        <label>数量</label>
        <input
          type="number"
          step="0.000001"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          required
        />
      </div>
      
      <button
        type="submit"
        className={`submit-btn ${side}`}
        disabled={loading || !isConnected}
      >
        {loading ? '提交中...' : `${side === 'buy' ? '买入' : '卖出'} ${pair.split('/')[0]}`}
      </button>
      
      {!isConnected && (
        <div className="warning">P2P 节点未连接，请稍候...</div>
      )}
    </form>
  )
}
