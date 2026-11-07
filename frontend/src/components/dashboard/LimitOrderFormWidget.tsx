import { useEffect, useState } from 'react'
import { Paper, Text, Select, NumberInput, Button, Stack, Slider } from '@mantine/core'
import { ethers, Contract } from 'ethers'
import { formatError, formatTokenAmount, getProvider } from '../../utils'
import { nodePost } from '../../nodeClient'
import { p2pOrderBroadcast } from '../../p2p/orderBroadcast'
import { signOrder, generateOrderId, fetchOrderNonce } from '../../services/orderSigning'
import { verifyOrderSignatureSignedData } from '../../services/orderVerification'
import { TOKEN0_ADDRESS, TOKEN1_ADDRESS, ERC20_ABI } from '../../config'
import { StandardConnect } from '../StandardConnect'
import type { Signer } from 'ethers'

const DEFAULT_PAIR = 'TKA/TKB'
const [BASE_SYMBOL, QUOTE_SYMBOL] = DEFAULT_PAIR.split('/')
const PCT_MARKS = [
  { value: 0, label: '0%' },
  { value: 25, label: '25%' },
  { value: 50, label: '50%' },
  { value: 75, label: '75%' },
  { value: 100, label: '100%' },
]

interface LimitOrderFormWidgetProps {
  account: string | null
  getSigner: () => Promise<Signer | null>
  recommendedPrice?: string
  /** 盘口点击带入的价格（seq 递增触发写入，避免与用户手输冲突） */
  externalPrice?: { price: string; seq: number }
  onSuccess?: () => void
}

function trimNum(n: number, digits = 6): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  return String(parseFloat(n.toFixed(digits)))
}

export function LimitOrderFormWidget({ account, getSigner, recommendedPrice, externalPrice, onSuccess }: LimitOrderFormWidgetProps) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [price, setPrice] = useState(recommendedPrice ?? '')
  const [amount, setAmount] = useState('')
  const [pct, setPct] = useState(0)
  const [balance, setBalance] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 盘口点击带入价格
  useEffect(() => {
    if (externalPrice && externalPrice.seq > 0 && externalPrice.price) {
      setPrice(externalPrice.price)
    }
  }, [externalPrice])

  // 可用余额：与完整订单簿同源（链上 ERC20 balanceOf；卖出花 TKA、买入花 TKB）
  useEffect(() => {
    let cancelled = false
    const fetchBalance = async () => {
      if (!account) {
        setBalance('')
        return
      }
      try {
        const provider = getProvider()
        if (!provider) return
        const token = new Contract(side === 'sell' ? TOKEN0_ADDRESS : TOKEN1_ADDRESS, ERC20_ABI, provider)
        const bal = await token.balanceOf(account)
        if (!cancelled) setBalance(formatTokenAmount(bal))
      } catch {
        if (!cancelled) setBalance('')
      }
    }
    fetchBalance()
    return () => {
      cancelled = true
    }
  }, [account, side])

  const pickSide = (next: 'buy' | 'sell') => {
    setSide(next)
    setPct(0)
    if (recommendedPrice) setPrice(recommendedPrice)
  }

  /** 百分比滑杆：按可用余额比例换算数量（买入需按当前价格把 TKB 余额折算为 TKA 数量） */
  const handlePctChange = (value: number) => {
    setPct(value)
    const bal = parseFloat(balance)
    if (Number.isNaN(bal) || bal <= 0) return
    if (side === 'sell') {
      setAmount(trimNum((bal * value) / 100))
    } else {
      const p = parseFloat(price)
      if (Number.isNaN(p) || p <= 0) return
      setAmount(trimNum((bal * value) / 100 / p))
    }
  }

  const handlePlaceOrder = async () => {
    if (!account) {
      setError('请先连接钱包')
      return
    }
    const p = parseFloat(price)
    const a = parseFloat(amount)
    if (Number.isNaN(p) || p <= 0 || Number.isNaN(a) || a <= 0) {
      setError('请输入有效的价格和数量')
      return
    }
    setError(null)
    setLoading(true)
    try {
      const signer = await getSigner()
      if (!signer) throw new Error('请先连接钱包')
      const timestamp = Math.floor(Date.now() / 1000)
      const expiresAt = timestamp + 86400
      const amountInWei = ethers.parseUnits(amount, 18)
      const priceWei = ethers.parseUnits(price, 18)
      const amountOutWei = (BigInt(amountInWei.toString()) * BigInt(priceWei.toString())) / BigInt(1e18)
      const orderId = generateOrderId()
      // 统一规范：签名必须带链上结算 nonce（结算时被合约消耗）；广播/入库的 nonce 字段同此值，不再用时间戳冒充
      const nonce = await fetchOrderNonce(account, signer)
      const orderData = {
        orderId,
        userAddress: account,
        tokenIn: TOKEN0_ADDRESS,
        tokenOut: TOKEN1_ADDRESS,
        amountIn: amountInWei.toString(),
        amountOut: String(amountOutWei),
        price: priceWei.toString(),
        timestamp,
        expiresAt,
        nonce,
      }
      const signature = await signOrder(orderData, signer)
      const valid = await verifyOrderSignatureSignedData(orderData, signature)
      if (!valid) throw new Error('订单签名验证失败，请重试')
      const order = {
        orderId,
        trader: account,
        pair: DEFAULT_PAIR,
        side: side as 'buy' | 'sell',
        price: orderData.price,
        amount: orderData.amountIn,
        filled: '0',
        status: 'open',
        nonce,
        createdAt: timestamp,
        expiresAt,
        signature,
      }
      await nodePost('/api/order', order)
      await p2pOrderBroadcast.publishOrder(order)
      setPrice('')
      setAmount('')
      setPct(0)
      onSuccess?.()
    } catch (e) {
      setError(formatError(e))
    } finally {
      setLoading(false)
    }
  }

  const priceNum = parseFloat(price)
  const amountNum = parseFloat(amount)
  const total =
    !Number.isNaN(priceNum) && !Number.isNaN(amountNum) && priceNum > 0 && amountNum > 0
      ? priceNum * amountNum
      : null
  const spendSymbol = side === 'sell' ? BASE_SYMBOL : QUOTE_SYMBOL

  return (
    <Paper p="md" style={{ background: 'transparent' }}>
      <Text size="sm" fw={600} mb="xs">
        下单 · {DEFAULT_PAIR}
      </Text>
      <Stack gap="sm">
        <div className="side-toggle" role="group" aria-label="买卖方向">
          <Button
            className="side-toggle-btn"
            color="up"
            variant={side === 'buy' ? 'filled' : 'light'}
            onClick={() => pickSide('buy')}
          >
            买入
          </Button>
          <Button
            className="side-toggle-btn"
            color="down"
            variant={side === 'sell' ? 'filled' : 'light'}
            onClick={() => pickSide('sell')}
          >
            卖出
          </Button>
        </div>
        <Select
          label="订单类型"
          data={[{ value: 'limit', label: '限价单' }]}
          value="limit"
          disabled
          description="当前仅支持限价单"
        />
        <NumberInput
          label={`价格 (${QUOTE_SYMBOL})`}
          value={price || undefined}
          onChange={(v) => setPrice(String(v ?? ''))}
          min={0}
          decimalScale={4}
          placeholder={recommendedPrice ?? '0'}
        />
        <NumberInput
          label={`数量 (${BASE_SYMBOL})`}
          value={amount || undefined}
          onChange={(v) => {
            setAmount(String(v ?? ''))
            setPct(0)
          }}
          min={0}
          decimalScale={4}
        />
        <div>
          <Slider
            value={pct}
            onChange={handlePctChange}
            marks={PCT_MARKS}
            step={1}
            min={0}
            max={100}
            size="sm"
            color="brand"
            disabled={!account || !balance}
            aria-label="可用余额比例"
          />
          <Text size="xs" c="dimmed" mt={4}>
            {account
              ? balance
                ? `可用 ${balance} ${spendSymbol}`
                : '可用余额加载中…'
              : '连接钱包后可按比例下单'}
          </Text>
        </div>
        {total != null && (
          <div className="order-total-row">
            <span>总额</span>
            <span className="order-total-val">
              {trimNum(total)} {QUOTE_SYMBOL}
            </span>
          </div>
        )}
        {error && (
          <Text size="sm" c="red" mb={4} role="alert">
            {error}
          </Text>
        )}
        {!account && (
          <div className="order-connect-cta">
            <Text size="sm" c="dimmed">
              行情与盘口可直接浏览；下单需要先连接钱包。
            </Text>
            <StandardConnect />
          </div>
        )}
        <Button
          className="btn-primary-action"
          fullWidth
          color={side === 'buy' ? 'up' : 'down'}
          size="md"
          onClick={handlePlaceOrder}
          loading={loading}
          disabled={!account || !price || !amount}
        >
          {side === 'buy' ? `买入 ${BASE_SYMBOL}` : `卖出 ${BASE_SYMBOL}`}
        </Button>
      </Stack>
    </Paper>
  )
}
