/**
 * 订单副发到公告栏中继（第三十轮，无节点化阶段 1 的「双发」）。
 *
 * 调用时机：与节点 POST /api/order 并行双通道投递（阶段 4 起，经
 * orderService.broadcastOrderDualChannel）。用同一份订单原文 + chainId
 * POST 到中继的 /orders（中继按该链的 EIP-712 域自行验签、按 digest 去重）。
 *
 * 纪律（best-effort）：本函数永不抛错——开关关 / URL 未配置时静默跳过；
 * 网络失败或中继拒绝时只 console.debug 并返回 false。第 45 轮 A1 起
 * fetch 带 15s 显式超时（AbortSignal.timeout），挂死连接超时后同按
 * 失败吞掉。下单的成功/失败语义（任一通道接单即成功）由调用方按
 * 本函数与节点投递的合并结果裁定。
 */
import { RELAY_URL, RELAY_DUAL_SEND_ENABLED } from '../config/relay'

/** 中继副发单次请求超时（第 45 轮 A1）：中继连接挂死时按时 abort，不拖住下单广播 */
export const RELAY_SEND_TIMEOUT_MS = 15_000

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
      signal:
        typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(RELAY_SEND_TIMEOUT_MS)
          : undefined,
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
