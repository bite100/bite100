import { ethers } from 'ethers'
import { CHAIN_ID } from '../config'
import { nodePost } from '../nodeClient'
import { dualSendOrderToRelay } from './relayDualSend'
import { signOrder, signCancelOrder, generateOrderId, fetchOrderNonce, OrderData } from './orderSigning'
import { sideToSignedValue } from './orderSigningTypes'

/**
 * 双通道广播结果：哪条通道接了单（截至返回时刻的快照——先接单者
 * 触发返回，未落定的通道标志为 false，其迟到结果只留 console 痕迹）；
 * 节点通道失败时 nodeError 带节点侧原始错误（期限内未响应时为超时错误）。
 */
export interface OrderBroadcastOutcome {
  viaNode: boolean
  viaRelay: boolean
  nodeError?: unknown
}

/** 双通道广播期限：任一通道挂死都不得把下单返回拖过这个上限（第 45 轮 A1） */
export const BROADCAST_CHANNEL_DEADLINE_MS = 20_000

/**
 * 订单双通道广播（无节点化阶段 4；第 45 轮 A1 改竞速语义）：同一份
 * 订单原文**并行**投递节点（POST /api/order）与公告栏中继
 * （dualSendOrderToRelay，POST /orders），**任一通道先接单即返回
 * 成功**，不再等落败通道——旧实现 Promise.all 等双通道都落定，
 * 一个通道挂死（无超时连接）会把下单返回无限拖住。落败通道的迟到
 * 结果安全忽略、只 console.debug 留痕（迟到接单的订单照常入簿：
 * 同一签名订单，中继按 EIP-712 digest 去重、节点按 orderId 去重，
 * 下游只认一个订单身份）。双通道都失败才返回失败（nodeError 带
 * 节点侧原始错误）；双通道都挂死时在广播期限处按失败返回（节点侧
 * 记超时错误），下单返回永远有界。本函数不抛错，双失败的抛错口径
 * 由调用方决定（与旧口径一致）。
 */
export async function broadcastOrderDualChannel(
  orderBody: Record<string, unknown>,
  chainId: number,
): Promise<OrderBroadcastOutcome> {
  return new Promise<OrderBroadcastOutcome>((resolve) => {
    let viaNode = false
    let viaRelay = false
    let nodeError: unknown
    let nodeSettled = false
    let relaySettled = false
    let finished = false
    let finishScheduled = false
    let deadline: ReturnType<typeof setTimeout> | undefined

    const finish = () => {
      if (finished) return
      finished = true
      if (deadline) clearTimeout(deadline)
      resolve(viaNode ? { viaNode, viaRelay } : { viaNode, viaRelay, nodeError })
    }
    // 先接单者触发返回；同一宏任务轮次内落定的另一通道结果一并带上
    //（双通道同时接单时两侧标志都为真），只多等一个 tick，不等挂死通道。
    const scheduleFinish = () => {
      if (finishScheduled || finished) return
      finishScheduled = true
      setTimeout(finish, 0)
    }
    const maybeFinish = () => {
      if (viaNode || viaRelay) scheduleFinish()
      else if (nodeSettled && relaySettled) finish()
    }
    deadline = setTimeout(() => {
      if (!nodeSettled && nodeError === undefined) {
        nodeError = new Error(
          `订单广播节点通道超时（>${BROADCAST_CHANNEL_DEADLINE_MS / 1000}s 未响应）`,
        )
      }
      if (!relaySettled) {
        console.debug('[broadcast] 中继通道在广播期限内未落定，按未接单返回（迟到结果另行留痕）')
      }
      finish()
    }, BROADCAST_CHANNEL_DEADLINE_MS)

    nodePost('/api/order', orderBody).then(
      () => {
        nodeSettled = true
        viaNode = true
        if (finished) {
          console.debug(
            '[broadcast] 节点通道迟到接单：广播已返回，订单已由节点通道入簿（同一签名订单，下游按 orderId/digest 只认一个身份）',
          )
          return
        }
        maybeFinish()
      },
      (error: unknown) => {
        nodeSettled = true
        nodeError = error
        if (finished) {
          console.debug('[broadcast] 节点通道迟到失败：广播已返回', error)
          return
        }
        maybeFinish()
      },
    )
    dualSendOrderToRelay(orderBody, chainId).then((ok) => {
      relaySettled = true
      viaRelay = ok
      if (finished) {
        console.debug(
          `[broadcast] 中继通道迟到落定 ok=${ok}：广播已返回${ok ? '，订单已由中继通道入簿（同一签名订单，下游按 digest/orderId 只认一个身份）' : ''}`,
        )
        return
      }
      maybeFinish()
    })
  })
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

  // 构造订单数据
  const orderData: OrderData = {
    orderId,
    userAddress: address,
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: ethers.parseUnits(params.amountIn, 18).toString(),
    amountOut: ethers.parseUnits(params.amountOut, 18).toString(),
    price: ethers.parseUnits(params.price, 18).toString(),
    timestamp,
    expiresAt,
    nonce,
    side: sideToSignedValue(params.side),
  }

  // 签名订单（域按当前链生成）
  const signature = await signOrder(orderData, signer, CHAIN_ID)

  // 提交到 P2P 节点（nonce/expiresAt 必须随单提交，节点按签名原文重建验签）
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
  // 双通道并行广播：任一通道接单即下单成功；双通道都失败才失败，
  // 抛出节点侧原始错误（保持既有错误面貌）。
  const broadcast = await broadcastOrderDualChannel(orderBody, CHAIN_ID)
  if (!broadcast.viaNode && !broadcast.viaRelay) {
    throw broadcast.nodeError instanceof Error
      ? broadcast.nodeError
      : new Error('订单广播失败：节点与中继通道均未接单')
  }

  return orderId
}

export async function cancelOrder(
  orderID: string,
  signer: ethers.Signer
): Promise<void> {
  const address = await signer.getAddress()
  const timestamp = Math.floor(Date.now() / 1000)
  
  const signature = await signCancelOrder(orderID, address, timestamp, signer, CHAIN_ID)
  
  await nodePost('/api/order/cancel', {
    orderId: orderID,
    signature,
  })
}
