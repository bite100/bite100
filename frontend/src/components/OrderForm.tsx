import React, { useState, useEffect, useCallback } from 'react'
import { ethers, Contract } from 'ethers'
import { useP2P } from '../contexts/P2PContext'
import { signOrder, generateOrderId } from '../services/orderSigning'
import { verifyOrderSignatureSignedData } from '../services/orderVerification'
import { usePairMarketPrice } from '../hooks/useTokenPrice'
import { TOKEN0_ADDRESS, TOKEN1_ADDRESS, ERC20_ABI } from '../config'
import { getProvider, formatTokenAmount } from '../utils'
import { FeeDisplay } from './FeeDisplay'
import { ErrorDisplay } from './ErrorDisplay'
import { useGasEstimate } from '../hooks/useGasEstimate'
import './OrderForm.css'

interface OrderFormProps {
  pair: string
  account: string | null
  onSuccess?: () => void
}

type OrderStatus = 'idle' | 'pending' | 'success' | 'failed'

export function OrderForm({ pair, account, onSuccess }: OrderFormProps) {
  const { publishOrder, isConnected } = useP2P()
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [price, setPrice] = useState('')
  const [amount, setAmount] = useState('')
  const [loading, setLoading] = useState(false)
  const [orderStatus, setOrderStatus] = useState<OrderStatus>('idle')
  const [balance, setBalance] = useState<string>('')
  const [balanceLoading, setBalanceLoading] = useState(false)
  const [priceImpact, setPriceImpact] = useState<number | null>(null)
  const { basePrice, quotePrice, loading: priceLoading, error: priceError } = usePairMarketPrice(pair)
  const { estimate: gasEstimate, loading: gasLoading } = useGasEstimate(!!account && !!price && !!amount)
  const [error, setError] = useState<unknown>(null)

  // 获取余额
  const fetchBalance = useCallback(async () => {
    if (!account) {
      setBalance('')
      return
    }
    setBalanceLoading(true)
    try {
      const provider = getProvider()
      if (!provider) return
      const tokenAddress = side === 'sell' ? TOKEN0_ADDRESS : TOKEN1_ADDRESS
      const token = new Contract(tokenAddress, ERC20_ABI, provider)
      const bal = await token.balanceOf(account)
      setBalance(formatTokenAmount(bal))
    } catch (e) {
      console.error('获取余额失败:', e)
      setBalance('')
    } finally {
      setBalanceLoading(false)
    }
  }, [account, side])

  useEffect(() => {
    fetchBalance()
  }, [fetchBalance])

  // 计算价格影响（滑点）
  useEffect(() => {
    if (!price || !amount || !basePrice || priceLoading) {
      setPriceImpact(null)
      return
    }
    try {
      const orderPrice = parseFloat(price)
      const marketPrice = basePrice.usd
      if (marketPrice > 0) {
        const impact = Math.abs((orderPrice - marketPrice) / marketPrice) * 100
        setPriceImpact(impact)
      }
    } catch {
      setPriceImpact(null)
    }
  }, [price, amount, basePrice, priceLoading])

  // 输入验证
  const validateInput = useCallback((): string | null => {
    if (!price || !amount) {
      return '请输入价格和数量'
    }
    const p = parseFloat(price)
    const a = parseFloat(amount)
    if (Number.isNaN(p) || p <= 0) {
      return '价格必须大于 0'
    }
    if (Number.isNaN(a) || a <= 0) {
      return '数量必须大于 0'
    }
    if (p > 1000000) {
      return '价格过高，请检查输入'
    }
    if (a > 1000000000) {
      return '数量过大，请检查输入'
    }
    // 余额检查
    if (account && balance) {
      const balanceNum = parseFloat(balance)
      const amountNum = parseFloat(amount)
      if (!Number.isNaN(balanceNum) && !Number.isNaN(amountNum) && amountNum > balanceNum) {
        return `余额不足。当前余额：${balance}，需要：${amount}`
      }
    }
    // 滑点保护提示（超过5%）
    if (priceImpact !== null && priceImpact > 5) {
      return `价格影响较大（${priceImpact.toFixed(2)}%），建议调整价格`
    }
    return null
  }, [price, amount, account, balance, priceImpact])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    const validationError = validateInput()
    if (validationError) {
      setError(validationError)
      return
    }

    if (!isConnected) {
      setError('P2P 节点未连接，请稍候')
      return
    }
    const provider = getProvider()
    if (!provider) {
      setError('请安装 MetaMask 并连接')
      return
    }

    setLoading(true)
    setOrderStatus('pending')
    setError(null)
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

      setOrderStatus('success')
      setError(null)
      setPrice('')
      setAmount('')
      await fetchBalance()
      setTimeout(() => {
        setOrderStatus('idle')
        onSuccess?.()
      }, 2000)
    } catch (error) {
      console.error('提交订单失败:', error)
      setError(error)
      setOrderStatus('failed')
      setTimeout(() => setOrderStatus('idle'), 3000)
    } finally {
      setLoading(false)
    }
  }

  return (
    <form className="order-form" onSubmit={handleSubmit}>
      <h3>下单 - {pair}</h3>
      <ErrorDisplay error={error} onDismiss={() => setError(null)} />
      
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
          min="0.000001"
          max="1000000"
          value={price}
          onChange={(e) => {
            const val = e.target.value
            if (val === '' || /^\d*\.?\d*$/.test(val)) {
              setPrice(val)
              setError(null)
            }
          }}
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
        {!priceLoading && priceError && (
          <p className="order-form-market-hint text-muted">
            市场参考价服务暂时不可用，不影响下单。
          </p>
        )}
      </div>
      
      <div className="form-group">
        <label>数量</label>
        <input
          type="number"
          step="0.000001"
          min="0.000001"
          max="1000000000"
          value={amount}
          onChange={(e) => {
            const val = e.target.value
            if (val === '' || /^\d*\.?\d*$/.test(val)) {
              setAmount(val)
              setError(null)
            }
          }}
          placeholder="0.00"
          required
        />
        {account && (
          <div className="balance-info">
            {balanceLoading ? (
              <span className="text-muted">加载余额中...</span>
            ) : balance ? (
              <span className="text-muted">
                余额：{balance} {side === 'sell' ? pair.split('/')[0] : pair.split('/')[1]}
              </span>
            ) : (
              <span className="text-muted">无法获取余额</span>
            )}
          </div>
        )}
      </div>
      {price && amount && !Number.isNaN(Number(price)) && !Number.isNaN(Number(amount)) && Number(price) > 0 && Number(amount) > 0 && (
        <div className="order-summary">
          <p>
            以 <strong>{price}</strong> 的价格{side === 'buy' ? '买入' : '卖出'} <strong>{amount}</strong> 个 {pair.split('/')[0]}
          </p>
          {priceImpact !== null && priceImpact > 0 && (
            <p className={`price-impact ${priceImpact > 5 ? 'warning' : priceImpact > 2 ? 'caution' : 'normal'}`}>
              价格影响：{priceImpact.toFixed(2)}%
              {priceImpact > 5 && ' ⚠️ 影响较大'}
            </p>
          )}
          {gasEstimate && !gasLoading && (
            <p className="gas-estimate text-muted">
              预计 Gas：{ethers.formatEther(gasEstimate.totalCost).slice(0, 8)} ETH
              {gasEstimate.suggestion && <span className="gas-suggestion"> · {gasEstimate.suggestion}</span>}
            </p>
          )}
        </div>
      )}
      <button
        type="submit"
        className={`submit-btn ${side} ${orderStatus === 'success' ? 'success' : orderStatus === 'failed' ? 'failed' : ''}`}
        disabled={loading || !isConnected || orderStatus === 'pending'}
      >
        {orderStatus === 'pending' && '提交中...'}
        {orderStatus === 'success' && '✓ 订单已提交'}
        {orderStatus === 'failed' && '✗ 提交失败'}
        {orderStatus === 'idle' && (loading ? '提交中...' : `${side === 'buy' ? '买入' : '卖出'} ${pair.split('/')[0]}`)}
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
