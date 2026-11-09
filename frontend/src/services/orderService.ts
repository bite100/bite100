import { ethers } from 'ethers'
import { CHAIN_ID } from '../config'
import { RELAY_URL } from '../config/relay'
import { signOrder, generateOrderId, fetchOrderNonce, OrderData } from './orderSigning'
import { sideToSignedValue } from './orderSigningTypes'

/**
 * 中继广播结果：第 51 轮（阶段 5 节点退役）起下单只有中继一条通道。
 * - viaRelay=true：中继已明确接单（HTTP 成功）。
 * - relayError：中继明确拒单（HTTP 非 2xx，带中继返回的原因）或未配置。
 * - relayUnknown=true：传输层失败/超时——请求可能已达中继、只是回执
 *   没回来，结果是 UNKNOWN 不是失败（第 46 轮 P2-3 口径，单源沿用）：
 *   调用方必须按「待确认」呈现，不得断言未接单（见
 *   BROADCAST_UNKNOWN_MESSAGE）。
 */
export interface OrderBroadcastOutcome {
  viaRelay: boolean
  relayError?: unknown
  relayUnknown?: boolean
}

/** 下单结果待确认（UNKNOWN）时的统一用户文案，各下单路径共用 */
export const BROADCAST_UNKNOWN_MESSAGE =
  '订单结果待确认：中继通道超时、结果未定，订单可能已经入簿。请勿立即重复下单，稍后到「当前挂单」确认这张订单在不在。'

/** 中继发单超时（第 30 轮起的 15 秒纪律，自 relayDualSend 主发化沿用） */
export const RELAY_POST_TIMEOUT_MS = 15_000

/**
 * 订单广播（中继单通道）：把同一份订单原文 POST 到公告栏中继
 * /orders。语义：
 * - 中继明确接单（2xx）→ viaRelay。
 * - 中继明确拒单（非 2xx）→ relayError 带中继返回的原因文本——这是
 *   确定性失败（如签名校验不过），调用方应把原因呈现给用户。
 * - 传输层失败（超时/网络错误）→ relayUnknown：中继可能已接单只是
 *   回执未回，按 UNKNOWN 处理。本函数不抛错，抛错口径由调用方决定。
 * 本函数永远有界：fetch 带 AbortSignal.timeout(RELAY_POST_TIMEOUT_MS)，
 * 不再存在无界等待（第 45/51 轮根因纪律）。
 */
export async function broadcastOrder(
  orderBody: Record<string, unknown>,
  chainId: number,
): Promise<OrderBroadcastOutcome> {
  if (!RELAY_URL) {
    return { viaRelay: false, relayError: new Error('订单中继未配置（VITE_RELAY_URL 为空），无法下单') }
  }
  try {
    const res = await fetch(`${RELAY_URL}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...orderBody, chainId }),
      signal: AbortSignal.timeout(RELAY_POST_TIMEOUT_MS),
    })
    if (res.ok) return { viaRelay: true }
    let detail = ''
    try {
      const body: unknown = await res.json()
      if (body && typeof body === 'object') {
        const b = body as Record<string, unknown>
        detail = String(b.error ?? b.message ?? '')
      }
    } catch {
      /* 响应体不是 JSON：只报状态码 */
    }
    return {
      viaRelay: false,
      relayError: new Error(
        `中继拒单（HTTP ${res.status}）${detail ? `：${detail}` : ''}`,
      ),
    }
  } catch (e) {
    // 超时（TimeoutError）与一切传输层失败：结果未定 → UNKNOWN
    return { viaRelay: false, relayUnknown: true, relayError: e }
  }
}

export interface OrderParams {
  tokenIn: string
  tokenOut: string
  amountIn: string
  amountOut: string
  price: string
  side: 'buy' | 'sell'
  type: 'limit' | 'market'
  pair: string
  /**
   * 代币小数位（第六十轮，自助上架对用）：amountIn 按 base 小数位缩放，
   * price 按 18+quote−base 缩放；amountOut 由 amountIn×price/1e18 推导，
   * 不再单独按 18 位缩放 params.amountOut（保证与中继重建口径逐位一致，
   * 见 docs/round60 §2）。缺省 = 种子对 18/18，行为与旧版一致。
   */
  decimals?: { base: number; quote: number }
}

export async function submitOrder(
  params: OrderParams,
  signer: ethers.Signer
): Promise<string> {
  const address = await signer.getAddress()
  const timestamp = Math.floor(Date.now() / 1000)
  const expiresAt = timestamp + 86400 // 24 小时后过期

  const orderId = generateOrderId()

  // 统一规范：签名必须带链上结算 nonce（结算时被合约消耗）
  const nonce = await fetchOrderNonce(address, signer, CHAIN_ID)

  // 构造订单数据（缩放口径见 OrderParams.decimals；缺省 18/18 与旧版一致，
  // 此时 amountOut 推导值与 parseUnits(params.amountOut, 18) 在调用方按
  // amountIn×price 取整时相等——既有调用方均按此口径传参）
  const baseDec = params.decimals?.base ?? 18
  const quoteDec = params.decimals?.quote ?? 18
  const priceDec = 18 + quoteDec - baseDec
  const amountInRaw = ethers.parseUnits(params.amountIn, baseDec)
  const priceRaw = ethers.parseUnits(params.price, priceDec)
  const amountOutRaw = (amountInRaw * priceRaw) / 10n ** 18n
  const orderData: OrderData = {
    orderId,
    userAddress: address,
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: amountInRaw.toString(),
    amountOut: amountOutRaw.toString(),
    price: priceRaw.toString(),
    timestamp,
    expiresAt,
    nonce,
    side: sideToSignedValue(params.side),
  }

  // 签名订单（域按当前链生成）
  const signature = await signOrder(orderData, signer, CHAIN_ID)

  // 提交到订单中继（nonce/expiresAt 必须随单提交，中继按签名原文重建验签）
  const orderBody = {
    orderId,
    trader: address,
    pair: params.pair,
    side: params.side,
    price: params.price,
    amount: params.amountIn,
    filled: '0',
    status: 'open',
    createdAt: timestamp,
    expiresAt,
    nonce,
    signature,
  }
  // 中继单通道广播：接单即下单成功；明确拒单抛中继原因；传输层失败
  //（结果未定）按待确认文案抛错，防用户误以为没下成而重复下单。
  const broadcast = await broadcastOrder(orderBody, CHAIN_ID)
  if (!broadcast.viaRelay) {
    if (broadcast.relayUnknown) throw new Error(BROADCAST_UNKNOWN_MESSAGE)
    throw broadcast.relayError instanceof Error
      ? broadcast.relayError
      : new Error('订单广播失败：中继未接单')
  }

  return orderId
}

/**
 * 签名撤单（cancelOrder）已随节点退役删除：第 51 轮——签名撤单原本
 * 只投递给节点订单簿（POST /api/order/cancel），中继簿没有撤单接口
 * （relay/ 合同只有 POST/GET /orders、GET /orderbook），无处可投递。
 * 撤单的真实路径是链上硬取消（services/hardCancel.ts + Vault 撤单
 * 墓碑，第 46/47 轮）：钱包直接上链释放锁定并永久作废订单。
 */
