/**
 * 订单公告栏中继配置（第三十轮，无节点化阶段 1：节点主发 + 中继副发双发）。
 *
 * 中继是无许可的订单公告栏（Cloudflare Workers + D1，仓库 relay/ 目录）：
 * 订单是自验签便签，中继只存与转、无钥无钱。下单成功语义只由节点主发决定，
 * 副发是 best-effort——失败只记 console.debug，绝不影响下单结果（见
 * services/relayDualSend.ts）。
 *
 * 环境变量：
 * - VITE_RELAY_URL：中继基地址（如 https://bit100-relay.<账号>.workers.dev）。
 *   为空时副发静默跳过（中继未部署/未配置时的默认安全形态）。
 * - VITE_RELAY_DUAL_SEND：副发开关，默认开；显式设为 false / 0 / off 才关。
 */

export const RELAY_URL: string = (import.meta.env.VITE_RELAY_URL ?? '')
  .trim()
  .replace(/\/$/, '')

const rawDualSend = (import.meta.env.VITE_RELAY_DUAL_SEND ?? '').trim().toLowerCase()

/** 副发开关（默认开；仅显式 false/0/off 关闭） */
export const RELAY_DUAL_SEND_ENABLED: boolean =
  rawDualSend !== 'false' && rawDualSend !== '0' && rawDualSend !== 'off'

/** 副发是否实际生效：开关开且中继 URL 已配置 */
export function isRelayDualSendActive(): boolean {
  return RELAY_DUAL_SEND_ENABLED && RELAY_URL !== ''
}
