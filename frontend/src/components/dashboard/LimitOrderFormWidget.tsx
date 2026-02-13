import { useState } from 'react'
import { Paper, Text, Select, NumberInput, Button, Stack } from '@mantine/core'
import { useMantineTheme } from '@mantine/core'
import { ethers } from 'ethers'
import { formatError } from '../../utils'
import { nodePost } from '../../nodeClient'
import { p2pOrderBroadcast } from '../../p2p/orderBroadcast'
import { signOrder, generateOrderId } from '../../services/orderSigning'
import { verifyOrderSignatureSignedData } from '../../services/orderVerification'
import { TOKEN0_ADDRESS, TOKEN1_ADDRESS } from '../../config'
import type { Signer } from 'ethers'

const DEFAULT_PAIR = 'TKA/TKB'

interface LimitOrderFormWidgetProps {
  account: string | null
  getSigner: () => Promise<Signer | null>
  recommendedPrice?: string
  onSuccess?: () => void
}

export function LimitOrderFormWidget({ account, getSigner, recommendedPrice, onSuccess }: LimitOrderFormWidgetProps) {
  const theme = useMantineTheme()
  const [side, setSide] = useState<string>('buy')
  const [price, setPrice] = useState(recommendedPrice ?? '')
  const [amount, setAmount] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleQuickBuy = () => {
    setSide('buy')
    if (recommendedPrice) setPrice(recommendedPrice)
  }

  const handleQuickSell = () => {
    setSide('sell')
    if (recommendedPrice) setPrice(recommendedPrice)
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
        nonce: timestamp,
        createdAt: timestamp,
        expiresAt,
        signature,
      }
      await nodePost('/api/order', order)
      await p2pOrderBroadcast.publishOrder(order)
      setPrice('')
      setAmount('')
      onSuccess?.()
    } catch (e) {
      setError(formatError(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Paper p="md" style={{ background: theme.colors.dark[8] ?? '#2C2E33', height: '100%', minHeight: 280 }}>
      <Text size="sm" fw={600} mb="xs" c="gray.3">
        挂单 · {DEFAULT_PAIR}
      </Text>
      <Stack gap="sm">
        <div style={{ display: 'flex', gap: 8 }}>
          <Button size="xs" color="green" onClick={handleQuickBuy}>一键买</Button>
          <Button size="xs" color="red" variant="light" onClick={handleQuickSell}>一键卖</Button>
        </div>
        <Select
          label="方向"
          data={[{ value: 'buy', label: '买入' }, { value: 'sell', label: '卖出' }]}
          value={side}
          onChange={(v) => v && setSide(v)}
        />
        <NumberInput
          label="价格"
          value={price || undefined}
          onChange={(v) => setPrice(String(v ?? ''))}
          min={0}
          decimalScale={4}
          placeholder={recommendedPrice ?? '0'}
        />
        <NumberInput
          label="数量"
          value={amount || undefined}
          onChange={(v) => setAmount(String(v ?? ''))}
          min={0}
          decimalScale={4}
        />
        {error && <Text size="xs" c="red">{error}</Text>}
        <Button
          fullWidth
          onClick={handlePlaceOrder}
          loading={loading}
          disabled={!account || !price || !amount}
        >
          挂单
        </Button>
      </Stack>
    </Paper>
  )
}
