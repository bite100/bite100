import React, { useState } from 'react'
import { ethers } from 'ethers'
import { useP2P } from '../contexts/P2PContext'
import { signOrder, generateOrderId } from '../services/orderSigning'
import { verifyOrderSignatureSignedData } from '../services/orderVerification'
import { usePairMarketPrice } from '../hooks/useTokenPrice'
import { TOKEN0_ADDRESS, TOKEN1_ADDRESS } from '../config'
import { getProvider } from '../utils'
import { FeeDisplay } from './FeeDisplay'
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
  const { basePrice, quotePrice, loading: priceLoading, error: priceError } = usePairMarketPrice(pair)

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
    const provider = getProvider()
    if (!provider) {
      alert('请安装 MetaMask 并连接')
      return
    }

    setLoading(true)
    try {
      await provider.send('eth_requestAccounts', [])
      const signer = await provider.getSigner()
      const address = await signer.getAddress()

      const orderId = generateOrderId()
      const timestamp = Math.floor(Date.now() / 1000)
      const expiresAt = timestamp + 86400
      const amountInWei = ethers.parseUnits(amount, 18)
      const priceWei = ethers.parseUnits(price, 18)
      const a = BigInt(amountInWei.toString())
      const p = BigInt(priceWei.toString())
      const amountOutWei = (a * p) / BigInt(1e18)

      const orderData = {
        orderId,
        userAddress: address,
        tokenIn: TOKEN0_ADDRESS,
        tokenOut: TOKEN1_ADDRESS,
        amountIn: amountInWei.toString(),
        amountOut: String(amountOutWei),
        price: priceWei.toString(),
        timestamp,
        expiresAt,
      }

      const signature = await signOrder(orderData, signer)
      const valid = await verifyOrderSignatureSignedData(orderData, signature)
      if (!valid) {
        throw new Error('订单签名验证失败，请重试')
      }

      await publishOrder({
        orderId,
        trader: address,
        pair,
        side,
        price: orderData.price,
        amount: orderData.amountIn,
        timestamp,
        expiresAt,
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
        {priceLoading && <p className="order-form-market-hint">加载参考价...</p>}
        {!priceLoading && !priceError && (basePrice || quotePrice) && (
          <p className="order-form-market-hint">
            <span className="text-muted">市场参考价：</span>
            {basePrice && <span>${basePrice.usd.toFixed(4)}</span>}
            {basePrice && quotePrice && <span> / ${quotePrice.usd.toFixed(4)}</span>}
            {basePrice?.usd_24h_change != null && (
              <span className={basePrice.usd_24h_change >= 0 ? 'text-green' : 'text-red'}>
                {' '}({basePrice.usd_24h_change >= 0 ? '+' : ''}{basePrice.usd_24h_change.toFixed(2)}%)
              </span>
            )}
            <span className="text-muted"> · P2P 零滑点限价 vs 主流 AMM 滑点 0.5%+</span>
          </p>
        )}
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

      <FeeDisplay
        platformFeePercent={0.01}
        feeDistribution={{ nodes: 20, developers: 30, liquidity: 50 }}
        showGasEstimate={true}
        tradeAmount={
          price && amount && !Number.isNaN(Number(price)) && !Number.isNaN(Number(amount))
            ? ethers.parseUnits(amount, 18)
            : undefined
        }
        className="order-form-fees"
      />
      
      {!isConnected && (
        <div className="warning">P2P 节点未连接，请稍候...</div>
      )}
    </form>
  )
}
