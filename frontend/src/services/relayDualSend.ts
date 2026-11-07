/**
 * 订单副发到公告栏中继（第三十轮，无节点化阶段 1 的「双发」）。
 *
 * 调用时机：节点 POST /api/order（主）成功之后。用同一份订单原文 + chainId
 * POST 到中继的 /orders（中继按该链的 EIP-712 域自行验签、按 digest 去重）。
 *
 * 纪律（best-effort）：本函数永不抛错——开关关 / URL 未配置时静默跳过；
 * 网络失败或中继拒绝时只 console.debug 并返回 false。下单的成功/失败语义
 * 永远只由节点主发决定，调用方不需要也不应该处理副发结果。
 */
import { RELAY_URL, RELAY_DUAL_SEND_ENABLED } from '../config/relay'

export async function dualSendOrderToRelay(
  order: Record<string, unknown>,
  chainId: number,
): Promise<boolean> {
  if (!RELAY_DUAL_SEND_ENABLED || RELAY_URL === '') return false
  try {
    const r = await fetch(`${RELAY_URL}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...order, chainId }),
    })
    if (!r.ok) {
      console.debug(`[relay] 订单副发被中继拒绝（不影响下单）: HTTP ${r.status}`)
      return false
    }
    return true
  } catch (e) {
    console.debug('[relay] 订单副发失败（不影响下单）', e)
    return false
  }
}
