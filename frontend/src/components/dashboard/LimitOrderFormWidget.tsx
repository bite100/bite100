import { useEffect, useState } from 'react'
import { Paper, Text, Select, NumberInput, Button, Stack, Slider, SegmentedControl } from '@mantine/core'
import { ethers, Contract } from 'ethers'
import { formatError, formatTokenAmount, getProvider } from '../../utils'
import { p2pOrderBroadcast } from '../../p2p/orderBroadcast'
import { signOrder, generateOrderId, fetchOrderNonce } from '../../services/orderSigning'
import { sideToSignedValue } from '../../services/orderSigningTypes'
import { broadcastOrderDualChannel, BROADCAST_NODE_UNKNOWN_MESSAGE } from '../../services/orderService'
import { FRONTEND_MATCHING_ENABLED } from '../../config/matching'
import { executeFrontendMatch } from '../../services/matching/execute'
import type { OrderData } from '../../services/orderSigningTypes'
import { verifyOrderSignatureSignedData } from '../../services/orderVerification'
import { ERC20_ABI, VAULT_ABI, VAULT_ADDRESS, CHAIN_ID } from '../../config'
import { DEFAULT_PAIR, getPairTokens } from '../../config/pairs'
import { StandardConnect } from '../StandardConnect'
import {
  bestOppositePrice,
  protectionPrice,
  estimateMarketFill,
  type MarketBookLevel,
} from './marketOrder'
import {
  ensureVaultBalance,
  orderObligationWei,
  shortfallWei,
  VaultTopUpError,
  type VaultTopUpStep,
} from './vaultTopUp'
import { useReferencePrice } from '../../hooks/useReferencePrice'
import { buildOrderDeliveryEstimate } from '../../services/defaultBridge/estimate'
import { getDisclosure } from '../../services/defaultBridge/disclosures'
import { loadSettings, pushTempOverride } from '../../services/defaultBridge/settings'
import { hasValidConfirmation } from '../../services/defaultBridge/support'
import {
  REFERENCE_SOURCE_LABELS,
  DEVIATION_WARN_PCT,
  deviationPct,
  isDeviationWarning,
} from '../../services/referencePrice'
import type { Signer } from 'ethers'

const PCT_MARKS = [
  { value: 0, label: '0%' },
  { value: 25, label: '25%' },
  { value: 50, label: '50%' },
  { value: 75, label: '75%' },
  { value: 100, label: '100%' },
]

interface LimitOrderFormWidgetProps {
  /** 第二十五轮：当前交易对（由交易台传入，随 URL ?pair= 切换） */
  pair?: string
  account: string | null
  getSigner: () => Promise<Signer | null>
  recommendedPrice?: string
  /** 盘口点击带入的价格（seq 递增触发写入，避免与用户手输冲突） */
  externalPrice?: { price: string; seq: number }
  /** 当前盘口快照（市价单保护价与预估成交用；人类单位） */
  book?: { bids: MarketBookLevel[]; asks: MarketBookLevel[] }
  /** 本所最近成交价与时间（第二十三轮参考价兜底来源；无成交为 null） */
  lastTradePrice?: number | null
  lastTradeAtSec?: number | null
  onSuccess?: () => void
  /**
   * 布局（第 31 轮）：full = 桌面完整布局（缺省，行为与文案不变）；
   * ticket = 移动交易页下单票——分段买卖、只读保护价行、菱形节点滑杆、关键键值行，
   * 长说明收进票内「下单说明」折叠区（文案只搬不删）。下单/签名/补存逻辑两布局完全共用。
   */
  layout?: 'full' | 'ticket'
}

function trimNum(n: number, digits = 6): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  return String(parseFloat(n.toFixed(digits)))
}

/** 参考价数据时间展示（本地时区，精确到秒） */
function fmtDataTime(sec: number): string {
  return new Date(sec * 1000).toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function LimitOrderFormWidget({ pair = DEFAULT_PAIR, account, getSigner, recommendedPrice, externalPrice, book, lastTradePrice, lastTradeAtSec, onSuccess, layout = 'full' }: LimitOrderFormWidgetProps) {
  const ticket = layout === 'ticket'
  // 第二十五轮：基础/计价代币随交易对取（chains.ts tokens 登记）；未登记的交易对不下单。
  const [baseSymbol, quoteSymbol] = pair.split('/')
  const pairTokens = getPairTokens(CHAIN_ID, pair)
  const baseToken = pairTokens?.base ?? ''
  const quoteToken = pairTokens?.quote ?? ''
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [orderType, setOrderType] = useState<'limit' | 'market'>('limit')
  const [price, setPrice] = useState(recommendedPrice ?? '')
  const [slippage, setSlippage] = useState('1')
  const [amount, setAmount] = useState('')
  const [pct, setPct] = useState(0)
  const [balance, setBalance] = useState('')
  const [availableWei, setAvailableWei] = useState<bigint | null>(null)
  const [lockedBalance, setLockedBalance] = useState('')
  const [loading, setLoading] = useState(false)
  const [topUpStep, setTopUpStep] = useState<VaultTopUpStep | null>(null)
  const [balanceTick, setBalanceTick] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // 第四十一轮：成交前交付预估（设计 §6）——askChoiceNote 记录本单的一次性临时选择回执
  const [askChoiceNote, setAskChoiceNote] = useState<string | null>(null)
  // 阶段 3 块 C：前端撮合结果口径（仅灰度开关开启时出现）
  const [matchNote, setMatchNote] = useState<string | null>(null)

  // 盘口点击带入价格：点击的语义是「按这个价下单」= 限价行为，切回限价单并带入价格
  useEffect(() => {
    if (externalPrice && externalPrice.seq > 0 && externalPrice.price) {
      setOrderType('limit')
      setPrice(externalPrice.price)
    }
  }, [externalPrice])

  // 可用余额：Vault 可用额（总额 − 挂单锁定；卖出花基础币、买入花计价币）。
  // 下单按可用额校验：挂单被节点接受时即锁定对应余额，可用不足的订单不进订单簿。
  useEffect(() => {
    let cancelled = false
    const fetchBalance = async () => {
      if (!account || !pairTokens) {
        setBalance('')
        setAvailableWei(null)
        setLockedBalance('')
        return
      }
      try {
        const provider = getProvider()
        if (!provider) return
        const spendToken = side === 'sell' ? baseToken : quoteToken
        const vault = new Contract(VAULT_ADDRESS, VAULT_ABI, provider)
        const [avail, locked] = await Promise.all([
          vault.availableBalance(account, spendToken) as Promise<bigint>,
          (vault.locked(account, spendToken).catch(() => 0n) as Promise<bigint>),
        ])
        if (!cancelled) {
          setBalance(formatTokenAmount(avail))
          setAvailableWei(avail)
          setLockedBalance(formatTokenAmount(locked))
        }
      } catch {
        if (!cancelled) {
          setBalance('')
          setAvailableWei(null)
          setLockedBalance('')
        }
      }
    }
    fetchBalance()
    return () => {
      cancelled = true
    }
  }, [account, side, balanceTick, pair, pairTokens])

  const pickSide = (next: 'buy' | 'sell') => {
    setSide(next)
    setPct(0)
    if (recommendedPrice) setPrice(recommendedPrice)
  }

  // ---- 市价单派生值：对手盘最优价 → 保护价 → 逐档预估成交 ----
  const bids = book?.bids ?? []
  const asks = book?.asks ?? []
  const bestOpp = orderType === 'market' ? bestOppositePrice(side, bids, asks) : null
  const slippageNum = parseFloat(slippage)
  const protection =
    bestOpp != null ? protectionPrice(side, bestOpp, Number.isNaN(slippageNum) ? 0 : slippageNum) : null
  const protectionStr = protection != null ? trimNum(protection, 6) : ''
  const amountNumPre = parseFloat(amount)
  const fillEstimate =
    orderType === 'market' && protection != null
      ? estimateMarketFill(side, Number.isNaN(amountNumPre) ? 0 : amountNumPre, side === 'buy' ? asks : bids, protection)
      : null
  /** 本单实际签名价格：限价单为填写价，市价单为自动推导的保护价 */
  const effectivePrice = orderType === 'market' ? protectionStr : price

  // ---- 第二十三轮：参考价（预言机优先；无喂价的对走本所成交/盘口兜底，口径见 services/referencePrice.ts） ----
  const refState = useReferencePrice(pair, {
    lastTradePrice: lastTradePrice ?? null,
    lastTradeAtSec: lastTradeAtSec ?? null,
    book,
  })
  const refOk = refState.status === 'ok' ? refState.ref : null
  /** 点击参考价预填：语义是「按参考价挂限价单」，与盘口点击带入一致地切回限价单 */
  const handleRefPriceClick = () => {
    if (!refOk) return
    setOrderType('limit')
    setPrice(trimNum(refOk.price, 6))
  }
  // 偏离警告只针对限价单手填价格（市价单价格由盘口推导，不在此列）；只警告、不拦截提交
  const limitPriceNum = parseFloat(price)
  const devPct = refOk && orderType === 'limit' ? deviationPct(limitPriceNum, refOk.price) : null
  const deviationWarning =
    refOk != null && orderType === 'limit' && isDeviationWarning(limitPriceNum, refOk.price)

  // ---- Part D：差额预估（用已加载的可用额做面板展示；提交前会重新读链上值复核） ----
  const displayShortfall = (() => {
    if (!account || availableWei == null) return null
    const a = parseFloat(amount)
    const p = parseFloat(effectivePrice)
    if (Number.isNaN(a) || a <= 0 || Number.isNaN(p) || p <= 0) return null
    try {
      const required = orderObligationWei(side, ethers.parseUnits(amount, 18), ethers.parseUnits(effectivePrice, 18))
      const sf = shortfallWei(required, availableWei)
      return sf > 0n ? { required, shortfall: sf } : null
    } catch {
      return null
    }
  })()

  /** 百分比滑杆：按可用余额比例换算数量（买入需按有效价格把计价币余额折算为基础币数量） */
  const handlePctChange = (value: number) => {
    setPct(value)
    const bal = parseFloat(balance)
    if (Number.isNaN(bal) || bal <= 0) return
    if (side === 'sell') {
      setAmount(trimNum((bal * value) / 100))
    } else {
      const p = parseFloat(effectivePrice)
      if (Number.isNaN(p) || p <= 0) return
      setAmount(trimNum((bal * value) / 100 / p))
    }
  }

  const handlePlaceOrder = async () => {
    if (!account) {
      setError('请先连接钱包')
      return
    }
    if (!pairTokens) {
      setError(`交易对 ${pair} 未登记代币地址，无法下单`)
      return
    }
    const a = parseFloat(amount)
    if (Number.isNaN(a) || a <= 0) {
      setError('请输入有效的数量')
      return
    }
    if (orderType === 'market' && bestOpp == null) {
      setError('当前盘口没有对手盘挂单，市价单无法成交。请等有挂单后再试，或改用限价单。')
      return
    }
    const p = parseFloat(effectivePrice)
    if (Number.isNaN(p) || p <= 0) {
      setError(orderType === 'market' ? '保护价计算失败，请刷新盘口后重试' : '请输入有效的价格')
      return
    }
    setError(null)
    setLoading(true)
    setTopUpStep(null)
    try {
      const signer = await getSigner()
      if (!signer) throw new Error('请先连接钱包')
      const timestamp = Math.floor(Date.now() / 1000)
      const expiresAt = timestamp + 86400
      const amountInWei = ethers.parseUnits(amount, 18)
      const priceWei = ethers.parseUnits(effectivePrice, 18)
      const amountOutWei = (BigInt(amountInWei.toString()) * BigInt(priceWei.toString())) / BigInt(1e18)

      // ---- Part D：一键补存差额（签名前；不足则先补、确认到账再继续） ----
      // 结算与挂单锁定都走 Vault 可用余额：这里用刚读回的链上值复核本单义务，
      // 差额在面板内补齐；补存被拒/失败/回读仍不足都会抛错停在签名前。
      const provider = getProvider()
      if (provider) {
        const spendToken = side === 'sell' ? baseToken : quoteToken
        const vaultRead = new Contract(VAULT_ADDRESS, VAULT_ABI, provider)
        const tokenRead = new Contract(spendToken, ERC20_ABI, provider)
        const [availFresh, walletBal] = await Promise.all([
          vaultRead.availableBalance(account, spendToken) as Promise<bigint>,
          tokenRead.balanceOf(account) as Promise<bigint>,
        ])
        const vaultWrite = new Contract(VAULT_ADDRESS, VAULT_ABI, signer)
        const tokenWrite = new Contract(spendToken, ERC20_ABI, signer)
        await ensureVaultBalance({
          requiredWei: orderObligationWei(side, amountInWei, priceWei),
          availableWei: availFresh,
          walletWei: walletBal,
          deps: {
            allowance: () => tokenRead.allowance(account, VAULT_ADDRESS) as Promise<bigint>,
            approve: async (amt) => {
              const tx = await tokenWrite.approve(VAULT_ADDRESS, amt)
              await tx.wait()
            },
            deposit: async (amt) => {
              const tx = await vaultWrite.deposit(spendToken, amt)
              await tx.wait()
            },
            available: () => vaultRead.availableBalance(account, spendToken) as Promise<bigint>,
          },
          onStep: (s) => setTopUpStep(s),
        })
        setTopUpStep(null)
        setBalanceTick((n) => n + 1)
      }

      const orderId = generateOrderId()
      // 统一规范：签名必须带链上结算 nonce（结算时被合约消耗）；广播/入库的 nonce 字段同此值，不再用时间戳冒充
      const nonce = await fetchOrderNonce(account, signer, CHAIN_ID)
      const orderData = {
        orderId,
        userAddress: account,
        tokenIn: baseToken,
        tokenOut: quoteToken,
        amountIn: amountInWei.toString(),
        amountOut: String(amountOutWei),
        price: priceWei.toString(),
        timestamp,
        expiresAt,
        nonce,
        side: sideToSignedValue(side),
      }
      const signature = await signOrder(orderData, signer, CHAIN_ID)
      const valid = await verifyOrderSignatureSignedData(orderData, signature, { chainId: CHAIN_ID })
      if (!valid) throw new Error('订单签名验证失败，请重试')
      const order = {
        orderId,
        trader: account,
        pair,
        side: side as 'buy' | 'sell',
        price: orderData.price,
        amount: orderData.amountIn,
        filled: '0',
        status: 'open',
        nonce,
        createdAt: timestamp,
        expiresAt,
        signature,
        // 市价单：签名价格即保护价，execType 是未签名的 IOC 执行指令（节点永不越过保护价）
        ...(orderType === 'market' ? { execType: 'market' } : {}),
      }
      // 阶段 4 双通道广播：同一订单原文并行投递节点与中继，任一接单即
      // 下单成功（节点停机时订单照样进中继簿）；双通道都失败才报错。
      const broadcast = await broadcastOrderDualChannel({ ...order }, CHAIN_ID)
      if (!broadcast.viaNode && !broadcast.viaRelay) {
        // UNKNOWN 优先于失败断言（第 46 轮 P2-3）：节点超时未定按
        // 待确认呈现，提示勿重复下单；订单随后入簿会按 digest 对齐。
        if (broadcast.nodeUnknown) throw new Error(BROADCAST_NODE_UNKNOWN_MESSAGE)
        throw broadcast.nodeError instanceof Error
          ? broadcast.nodeError
          : new Error('订单广播失败：节点与中继通道均未接单，请稍后重试')
      }
      // 第 45 轮 A1 后广播是竞速返回：viaNode=false 可能只是节点比中继
      // 慢、尚未落定；只有 nodeError 在场才是确知节点失败/超时，才出此提示。
      if (!broadcast.viaNode && broadcast.nodeError !== undefined) {
        setMatchNote('节点通道不可用，已由中继通道广播')
      }
      await p2pOrderBroadcast.publishOrder(order)
      // 阶段 3 块 C：前端撮合（灰度开关开启时）——广播后在本机以双读
      // 可成交集即时撮合、用户钱包自提批结算；任何失败都不影响已成功
      // 的下单（订单留簿走节点路径），结果只以一行口径呈现。
      if (FRONTEND_MATCHING_ENABLED) {
        try {
          const outcome = await executeFrontendMatch({
            chainId: CHAIN_ID,
            pair,
            takerData: orderData as OrderData,
            takerSignature: signature,
            signer,
          })
          setMatchNote(outcome.message)
        } catch (e) {
          setMatchNote(
            `前端撮合未执行（${e instanceof Error ? e.message.slice(0, 80) : '未知错误'}）；订单已留簿走节点路径。`,
          )
        }
      }
      setPrice('')
      setAmount('')
      setPct(0)
      onSuccess?.()
    } catch (e) {
      setError(e instanceof VaultTopUpError ? e.message : formatError(e))
    } finally {
      setLoading(false)
      setTopUpStep(null)
    }
  }

  const priceNum = parseFloat(effectivePrice)
  const amountNum = parseFloat(amount)
  const total =
    orderType === 'market'
      ? fillEstimate && fillEstimate.filledQty > 0
        ? fillEstimate.notional
        : null
      : !Number.isNaN(priceNum) && !Number.isNaN(amountNum) && priceNum > 0 && amountNum > 0
        ? priceNum * amountNum
        : null
  const spendSymbol = side === 'sell' ? baseSymbol : quoteSymbol
  // 下单票（ticket）键值行派生值：可买（买入按可用计价余额 ÷ 有效价）/ 预计可得（卖出）/ 预估手续费
  const balNum = parseFloat(balance)
  const estBuyQty =
    side === 'buy' && !Number.isNaN(balNum) && balNum > 0 && !Number.isNaN(priceNum) && priceNum > 0
      ? balNum / priceNum
      : null
  const estSellGet =
    side === 'sell' && !Number.isNaN(amountNum) && amountNum > 0 && !Number.isNaN(priceNum) && priceNum > 0
      ? amountNum * priceNum
      : null
  const estFee = total != null ? total * 0.0001 : null
  const topUpStepText =
    topUpStep === 'approving'
      ? '补存中：请在钱包中确认授权…'
      : topUpStep === 'depositing'
        ? '补存中：等待存入交易上链…'
        : topUpStep === 'verifying'
          ? '补存中：确认 Vault 到账…'
          : null

  return (
    <Paper p={ticket ? 0 : 'md'} style={{ background: 'transparent' }} className={ticket ? 'ticket-form' : undefined}>
      {!ticket && (
        <Text size="sm" fw={600} mb="xs">
          下单 · {pair}
        </Text>
      )}
      <Stack gap="sm">
        {ticket ? (
          <SegmentedControl
            value={side}
            onChange={(v) => pickSide(v === 'sell' ? 'sell' : 'buy')}
            data={[
              { value: 'buy', label: '买入' },
              { value: 'sell', label: '卖出' },
            ]}
            color={side === 'buy' ? 'up' : 'down'}
            fullWidth
            radius="xl"
            aria-label="买卖方向"
          />
        ) : (
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
        )}
        <div className={ticket ? 'ticket-type-row' : undefined}>
          <Select
            label={ticket ? undefined : '订单类型'}
            aria-label="订单类型"
            data={[
              { value: 'limit', label: '限价单' },
              { value: 'market', label: '市价单' },
            ]}
            value={orderType}
            onChange={(v) => setOrderType(v === 'market' ? 'market' : 'limit')}
            description={
              ticket
                ? undefined
                : orderType === 'limit'
                  ? '按指定价格或更优价格成交，未成交部分挂在盘口'
                  : '立即按盘口最优价逐档成交，未成交部分自动取消'
            }
          />
          {ticket && (
            <span
              className="ticket-type-info"
              title={
                orderType === 'limit'
                  ? '限价单：按指定价格或更优价格成交，未成交部分挂在盘口'
                  : '市价单：立即按盘口最优价逐档成交，未成交部分自动取消'
              }
            >
              ⓘ
            </span>
          )}
        </div>
        {/* 第二十三轮：参考价行（来源/时效口径见 services/referencePrice.ts）+ 产品内说明 */}
        <div>
          {refState.status === 'loading' && (
            <Text size="xs" c="dimmed">
              参考价加载中…
            </Text>
          )}
          {refState.status === 'ok' && (
            <Text size="xs" c="dimmed">
              参考价{' '}
              <button type="button" className="ref-price-value" onClick={handleRefPriceClick} title="点击填入价格框">
                {trimNum(refState.ref.price, 6)} {quoteSymbol}
              </button>{' '}
              · {REFERENCE_SOURCE_LABELS[refState.ref.source]} · 数据时间 {fmtDataTime(refState.ref.updatedAtSec)}
              （点击价格可填入）
            </Text>
          )}
          {refState.status === 'stale' && (
            <Text size="xs" c="orange">
              参考价暂时不可用（数据过期）：预言机最近更新于 {fmtDataTime(refState.updatedAtSec)}
              ，太旧的价格不再展示以免误导报价；没有参考价也可以照常下单。
            </Text>
          )}
          {refState.status === 'error' && (
            <Text size="xs" c="orange">
              参考价暂时不可用（读取失败），可稍后刷新重试；没有参考价也可以照常下单。
            </Text>
          )}
          {refState.status === 'none' && (
            <Text size="xs" c="dimmed">
              新市场，暂无参考价：这个交易对还没有成交记录、盘口也未形成双边报价，价格由挂单双方自行约定。
            </Text>
          )}
          {!ticket && (
            <Text size="xs" c="dimmed" mt={2}>
              参考价是什么：报价时的对照值，不是成交价。有 Chainlink
              预言机喂价的交易对读预言机聚合价；没有的用本所最近成交价或盘口中间价（来源已在上方标注）。实际成交价以盘口挂单为准，可能与参考价不同。
            </Text>
          )}
        </div>
        {orderType === 'limit' ? (
          <NumberInput
            label={`价格 (${quoteSymbol})`}
            value={price || undefined}
            onChange={(v) => setPrice(String(v ?? ''))}
            min={0}
            decimalScale={4}
            placeholder={recommendedPrice ?? '0'}
          />
        ) : ticket ? (
          <>
            {/* 下单票（第 31 轮）：市价单不展示滑点输入（滑点沿用默认 1%），改只读保护价行（第 17 轮口径） */}
            {bestOpp == null ? (
              <Text size="xs" c="red">
                当前盘口没有{side === 'buy' ? '卖盘' : '买盘'}挂单，市价单无法成交（节点会直接拒绝）。可改用限价单先挂单。
              </Text>
            ) : (
              <>
                <div className="kv ticket-protect-row">
                  <span className="k">{side === 'buy' ? '保护上限价' : '保护下限价'}</span>
                  <span className="v num">
                    {protectionStr} {quoteSymbol}
                    <small>市价单按保护价签名下单（限价机制）；超过此价不成交，未成交余量自动取消。</small>
                  </span>
                </div>
                {fillEstimate && amountNum > 0 && (
                  <Text size="xs" c="dimmed">
                    对手盘最优价 {trimNum(bestOpp, 6)} {quoteSymbol} · 预估成交均价{' '}
                    {fillEstimate.avgPrice != null ? trimNum(fillEstimate.avgPrice, 6) : '—'} {quoteSymbol}，可成交{' '}
                    {trimNum(fillEstimate.filledQty, 6)} / {trimNum(amountNum, 6)} {baseSymbol}
                    {!fillEstimate.fullyFilled &&
                      (fillEstimate.cappedByProtection
                        ? '（有档位超出保护价，超出部分不会成交）'
                        : '（盘口深度不足）')}
                  </Text>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <NumberInput
              label="滑点容忍 (%)"
              value={slippage || undefined}
              onChange={(v) => setSlippage(String(v ?? ''))}
              min={0}
              max={50}
              decimalScale={2}
              description="保护价 = 对手盘最优价按滑点放宽，成交永不超过这个价"
            />
            {bestOpp == null ? (
              <Text size="xs" c="red">
                当前盘口没有{side === 'buy' ? '卖盘' : '买盘'}挂单，市价单无法成交（节点会直接拒绝）。可改用限价单先挂单。
              </Text>
            ) : (
              <Text size="xs" c="dimmed">
                对手盘最优价 {trimNum(bestOpp, 6)} {quoteSymbol} · 保护价 {protectionStr} {quoteSymbol}
                {fillEstimate && amountNum > 0 && (
                  <>
                    {' '}· 预估成交均价 {fillEstimate.avgPrice != null ? trimNum(fillEstimate.avgPrice, 6) : '—'} {quoteSymbol}，可成交{' '}
                    {trimNum(fillEstimate.filledQty, 6)} / {trimNum(amountNum, 6)} {baseSymbol}
                    {!fillEstimate.fullyFilled &&
                      (fillEstimate.cappedByProtection
                        ? '（有档位超出保护价，超出部分不会成交）'
                        : '（盘口深度不足）')}
                  </>
                )}
              </Text>
            )}
          </>
        )}
        <NumberInput
          label={`数量 (${baseSymbol})`}
          value={amount || undefined}
          onChange={(v) => {
            setAmount(String(v ?? ''))
            setPct(0)
          }}
          min={0}
          decimalScale={4}
          rightSection={
            ticket ? (
              <button type="button" className="ticket-max" onClick={() => handlePctChange(100)}>
                最大
              </button>
            ) : undefined
          }
          rightSectionWidth={ticket ? 44 : undefined}
        />
        <div className={ticket ? 'ticket-slider' : undefined}>
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
          {!ticket && (
            <Text size="xs" c="dimmed" mt={4}>
              {account
                ? balance
                  ? `可用 ${balance} ${spendSymbol}` +
                    (lockedBalance && parseFloat(lockedBalance) > 0 ? ` · 锁定中 ${lockedBalance} ${spendSymbol}（挂单占用）` : '')
                  : '可用余额加载中…'
                : '连接钱包后可按比例下单'}
            </Text>
          )}
        </div>
        {ticket && (
          <div className="ticket-rows">
            <div className="kv">
              <span className="k">可用（Vault）</span>
              <span className="v num">
                {account
                  ? balance
                    ? `${balance} ${spendSymbol}`
                    : '加载中…'
                  : '连接钱包后显示'}
                {lockedBalance && parseFloat(lockedBalance) > 0 && (
                  <small>锁定中 {lockedBalance} {spendSymbol}（挂单占用）</small>
                )}
              </span>
            </div>
            {side === 'buy' && estBuyQty != null && (
              <div className="kv">
                <span className="k">可买</span>
                <span className="v num">
                  ≈ {trimNum(estBuyQty, 6)} {baseSymbol}
                </span>
              </div>
            )}
            {side === 'sell' && estSellGet != null && (
              <div className="kv">
                <span className="k">预计可得</span>
                <span className="v num">
                  ≈ {trimNum(estSellGet, 6)} {quoteSymbol}
                </span>
              </div>
            )}
          </div>
        )}
        {total != null && (
          <div className="order-total-row">
            <span>{orderType === 'market' ? '预估总额' : '总额'}</span>
            <span className="order-total-val">
              {trimNum(total)} {quoteSymbol}
            </span>
          </div>
        )}
        {ticket && (
          <div className="kv ticket-fee-row">
            <span className="k">预估手续费（0.01%）</span>
            <span className="v num">{estFee != null ? `≈ ${trimNum(estFee, 6)} ${quoteSymbol}` : '—'}</span>
          </div>
        )}
        {!ticket && (
          <Text size="xs" c="dimmed">
            费用提示：成交后从你收到的资产中扣除两项——交易手续费 0.01%，以及结算 gas 的一半
            （gas 由中继代付、无需自备原生代币，按实际成本买卖双方对半分摊，单方扣除不超过其收到金额的 10%）。
            因此实际到账会比成交金额少这两项；精确金额以结算上链时的实际 gas 为准。
          </Text>
        )}
        {displayShortfall && (
          <Text size="xs" c="orange">
            Vault 可用余额不足：本单需要 {formatTokenAmount(displayShortfall.required)} {spendSymbol}，还差{' '}
            {formatTokenAmount(displayShortfall.shortfall)} {spendSymbol}。不用去资产页——点下方按钮会先在本面板内把差额从你的钱包存入
            Vault（可能需要两次钱包确认：授权 + 存入），确认到账后自动继续下单；差额不足时不会签名提交。
          </Text>
        )}
        {/* 第四十一轮 §6：成交前交付预估（一行非阻塞）与三级询问（默认桥不支持时当场问一次，绝不静默换桥） */}
        {account &&
          (() => {
            const receivedAsset = side === 'buy' ? baseSymbol : quoteSymbol
            const est = buildOrderDeliveryEstimate({
              settings: loadSettings(account),
              settleChainId: CHAIN_ID,
              receivedAsset,
            })
            if (est.kind === 'line') {
              return (
                <Text size="xs" c="dimmed">
                  {est.text}
                </Text>
              )
            }
            if (est.kind === 'suspended') {
              return (
                <Text size="xs" c="orange">
                  {est.text}
                </Text>
              )
            }
            if (est.kind === 'ask') {
              if (askChoiceNote) {
                return (
                  <Text size="xs" c="dimmed" role="status">
                    {askChoiceNote}
                  </Text>
                )
              }
              const settings = loadSettings(account)
              return (
                <div>
                  <Text size="xs" c="orange">
                    {est.text}
                  </Text>
                  <Stack gap={6} mt={6}>
                    {est.supportedChannels.map((ch) => {
                      const ok = hasValidConfirmation(settings, ch)
                      return (
                        <Button
                          key={ch}
                          size="xs"
                          variant="light"
                          disabled={!ok}
                          title={ok ? undefined : '需先到跨链桥页默认通道设置里读完并确认该通道披露'}
                          onClick={() => {
                            pushTempOverride(account, {
                              channel: ch,
                              settleChainId: CHAIN_ID,
                              asset: receivedAsset,
                              createdAt: Date.now(),
                            })
                            setAskChoiceNote(
                              `已选：本次成交后经 ${getDisclosure(ch).name} 交付回你的主场链（一次性选择，不改变默认设置）。`
                            )
                          }}
                        >
                          本次改用 {getDisclosure(ch).name} 交付{ok ? '' : '（需先确认其披露）'}
                        </Button>
                      )
                    })}
                    <Button
                      size="xs"
                      variant="subtle"
                      onClick={() => {
                        pushTempOverride(account, {
                          channel: 'settle-chain-only',
                          settleChainId: CHAIN_ID,
                          asset: receivedAsset,
                          createdAt: Date.now(),
                        })
                        setAskChoiceNote('已选：本次成交款只留在成交链 Vault，不跨链交付（一次性选择）。')
                      }}
                    >
                      只在成交链交付
                    </Button>
                  </Stack>
                </div>
              )
            }
            return null
          })()}
        {error && (
          <Text size="sm" c="red" mb={4} role="alert">
            {error}
          </Text>
        )}
        {FRONTEND_MATCHING_ENABLED && (
          <Text size="sm" c="blue" mb={4}>
            前端撮合已开启：本单签名广播后会立即在本机撮合并由你的钱包提交批结算（整批原子，规则见下方说明）；未成交部分照常留簿走节点撮合。
          </Text>
        )}
        {matchNote && (
          <Text size="sm" c="dimmed" mb={4} role="status">
            {matchNote}
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
        {deviationWarning && refOk && devPct != null && (
          <Text size="sm" c="red" fw={600} role="alert">
            ⚠ 你填的价格 {trimNum(limitPriceNum, 6)} {quoteSymbol} 比参考价 {trimNum(refOk.price, 6)}{' '}
            {quoteSymbol} {devPct >= 0 ? '高' : '低'} {Math.abs(devPct).toFixed(1)}%——偏离超过{' '}
            {DEVIATION_WARN_PCT}% 时请先确认不是手误。P2P 挂单允许任意报价，若是故意报价可直接继续下单，这里只提醒、不拦截。
          </Text>
        )}
        <Button
          className="btn-primary-action"
          fullWidth
          color={side === 'buy' ? 'up' : 'down'}
          size="md"
          onClick={handlePlaceOrder}
          loading={loading}
          disabled={
            !account ||
            !pairTokens ||
            !amount ||
            (orderType === 'limit' ? !price : bestOpp == null)
          }
        >
          {topUpStepText ??
            (displayShortfall
              ? `补存 ${formatTokenAmount(displayShortfall.shortfall)} ${spendSymbol} 并下单`
              : side === 'buy'
                ? `买入 ${baseSymbol}`
                : `卖出 ${baseSymbol}`)}
        </Button>
        {ticket && (
          <Text size="xs" c="dimmed" className="ticket-gasnote">
            {FRONTEND_MATCHING_ENABLED
              ? '下单只需签名；前端撮合开启时，结算由你的钱包直接提交（需少量原生代币付 gas，该 gas 结算时由买卖双方对半分摊计量返还）。'
              : '下单只需签名，不发链上交易；gas 由中继代付、结算时买卖双方对半分摊，无需自备原生代币。'}
          </Text>
        )}
        {ticket ? (
          <details className="ticket-details">
            <summary>下单说明（参考价 / 费用 / 锁定 / 市价单规则）</summary>
            <Text size="xs" c="dimmed" component="div">
              <p>
                参考价是什么：报价时的对照值，不是成交价。有 Chainlink
                预言机喂价的交易对读预言机聚合价；没有的用本所最近成交价或盘口中间价（来源已在上方标注）。实际成交价以盘口挂单为准，可能与参考价不同。
              </p>
              <p>
                费用提示：成交后从你收到的资产中扣除两项——交易手续费 0.01%，以及结算 gas 的一半
                （gas 由中继代付、无需自备原生代币，按实际成本买卖双方对半分摊，单方扣除不超过其收到金额的 10%）。
                因此实际到账会比成交金额少这两项；精确金额以结算上链时的实际 gas 为准。
              </p>
              {FRONTEND_MATCHING_ENABLED && (
                <p>
                  前端撮合（当前已开启）：你的订单签名广播后，页面会在本机立即撮合——只吃经过双读与链上状态双重验证的可成交挂单，按价格-时间优先、成交价取对手挂单价（更优的价格归你）。撮合出的多笔成交会打包成一笔「批结算」由你的钱包直接提交上链：整批原子——提交前先模拟预检，已失效的对手单（已成交/过期/锁释放）会被剔除，剔不干净就整单不提交、订单留簿改走节点撮合，不会只成交一半；单批最多 50 笔，与合约上限一致。市价单同样适用：逐档吃到你的签名保护价为止，余量不成交、自动取消。注意：批结算由你的钱包发交易，需要少量原生代币付 gas；这笔 gas 在结算时按实际成本由买卖双方对半分摊计量（你先付、对方的一半从其成交所得中扣给你），提交失败的 gas 由发起者承担。未成交部分照常挂在盘口走节点撮合。
                </p>
              )}
              {orderType === 'market' && (
                <p>
                  市价单怎么成交：提交后立即按盘口最优价逐档吃单，成交价不会差于你签名的保护价（保护价 = 对手盘最优价按滑点容忍放宽，签名即绑定这个上限/下限，节点不能越过它成交；下单票按演示口径不展示滑点输入，沿用默认 1%）。吃到保护价或盘口深度用尽为止，没成交的部分立即自动取消、不挂到盘口上。锁定与限价单相同：下单时按保护价全额义务锁定 Vault 余额，成交部分由结算消耗，未成交部分与买单的价格改善差额会在结算完成后自动释放。盘口为空时节点会直接拒绝并报错。
                </p>
              )}
              <p>
                限价单按你填写的价格或更优价格成交，例如买单只会以不高于限价的价格买入，未成交部分继续挂在盘口等待成交。下单只需在钱包中签名：签名表示你授权这笔订单，订单本身不上链、不付 gas。下单使用 Vault 余额：订单被节点接受时即按订单义务锁定对应余额（卖单锁卖出币、买单按价格锁买入币），面板上的「可用」已扣除全部挂单锁定，可用不足的订单节点不会接受；成交时锁定按成交量消耗，未成交部分的锁定在撤单或订单到期后释放，锁定中的余额不能提取。Vault 可用不足时不用先去资产页：下单按钮会先在面板内一键补存差额（从钱包存入恰好差额，可能需要授权与存入两次钱包确认），确认到账后自动继续签名下单；补存的钱与普通存入没有区别，随时可在资产页提取。成交后由中继提交链上结算：你不需要自备原生代币付 gas；结算 gas 按实际成本由买卖双方对半分摊、以各自收到的资产扣除（单方扣除不超过其收到金额的 10%，超出部分平台吸收），交易手续费 0.01% 从成交金额中扣除，两条账分开计算。若因你的订单已过期或已被你撤单导致结算失败，失败所耗的 gas 由你承担。撤单有两种：在下方「当前挂单」中点「撤单」是签名撤单，只需签名、不上链，节点在线时由节点移除订单簿记录并代为释放锁定（释放不成功不阻断撤单，少数情况余额要等订单到期才释放）；点「链上撤单」则由你自己的钱包直接上链（自付少量 gas），立即释放这张单锁住的余额并在链上永久作废这张订单，节点不可用时也能撤。订单广播走节点与中继双通道，任一通道接单即下单成功，单个通道暂时不可用不影响下单。
              </p>
            </Text>
          </details>
        ) : (
          <>
            {orderType === 'market' && (
              <Text size="xs" c="dimmed">
                市价单怎么成交：提交后立即按盘口最优价逐档吃单，成交价不会差于你签名的保护价（保护价 = 对手盘最优价按上面滑点容忍放宽，签名即绑定这个上限/下限，节点不能越过它成交）。吃到保护价或盘口深度用尽为止，没成交的部分立即自动取消、不挂到盘口上。锁定与限价单相同：下单时按保护价全额义务锁定 Vault 余额，成交部分由结算消耗，未成交部分与买单的价格改善差额会在结算完成后自动释放。盘口为空时节点会直接拒绝并报错。
              </Text>
            )}
            {FRONTEND_MATCHING_ENABLED && (
              <Text size="xs" c="dimmed">
                前端撮合（当前已开启）：你的订单签名广播后，页面会在本机立即撮合——只吃经过双读与链上状态双重验证的可成交挂单，按价格-时间优先、成交价取对手挂单价（更优的价格归你）。撮合出的多笔成交会打包成一笔「批结算」由你的钱包直接提交上链：整批原子——提交前先模拟预检，已失效的对手单会被剔除，剔不干净就整单不提交、订单留簿改走节点撮合，不会只成交一半；单批最多 50 笔，与合约上限一致。市价单同样适用：逐档吃到你的签名保护价为止，余量自动取消。注意：批结算需要钱包里有少量原生代币付 gas；这笔 gas 在结算时按实际成本由买卖双方对半分摊计量（你先付、对方一半从其成交所得中扣给你），提交失败的 gas 由发起者承担。未成交部分照常走节点撮合。
              </Text>
            )}
            <Text size="xs" c="dimmed">
              限价单按你填写的价格或更优价格成交，例如买单只会以不高于限价的价格买入，未成交部分继续挂在盘口等待成交。下单只需在钱包中签名：签名表示你授权这笔订单，订单本身不上链、不付 gas。下单使用 Vault 余额：订单被节点接受时即按订单义务锁定对应余额（卖单锁卖出币、买单按价格锁买入币），面板上的「可用」已扣除全部挂单锁定，可用不足的订单节点不会接受；成交时锁定按成交量消耗，未成交部分的锁定在撤单或订单到期后释放，锁定中的余额不能提取。Vault 可用不足时不用先去资产页：下单按钮会先在面板内一键补存差额（从钱包存入恰好差额，可能需要授权与存入两次钱包确认），确认到账后自动继续签名下单；补存的钱与普通存入没有区别，随时可在资产页提取。成交后由中继提交链上结算：你不需要自备原生代币付 gas；结算 gas 按实际成本由买卖双方对半分摊、以各自收到的资产扣除（单方扣除不超过其收到金额的 10%，超出部分平台吸收），交易手续费 0.01% 从成交金额中扣除，两条账分开计算。若因你的订单已过期或已被你撤单导致结算失败，失败所耗的 gas 由你承担。撤单有两种：在下方「当前挂单」中点「撤单」是签名撤单，只需签名、不上链，节点在线时由节点移除订单簿记录并代为释放锁定（释放不成功不阻断撤单，少数情况余额要等订单到期才释放）；点「链上撤单」则由你自己的钱包直接上链（自付少量 gas），立即释放这张单锁住的余额并在链上永久作废这张订单，节点不可用时也能撤。订单广播走节点与中继双通道，任一通道接单即下单成功，单个通道暂时不可用不影响下单。
            </Text>
          </>
        )}
      </Stack>
    </Paper>
  )
}
