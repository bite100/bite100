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

/**
 * 第 34 轮（无节点阶段 2）双读三态模式：
 * - disabled：生产订单簿只读节点（现状），不拉公告栏、不算双读。
 * - shadow：拉公告栏与节点双读、算合并视图与影子指标供观察，
 *   生产订单簿仍只展示节点数据，行为零变化。
 * - active：合并视图（经链上状态机过滤后）进入展示——**尚未接线**
 *   （第 35 轮 D8）：生产订单簿（桌面 OrderBookWidget / 移动端
 *   useNodeOrderBook）仍只读节点 API，配了 active 也不会生效。
 *   阶段 3 接线前，请求 active 一律按 shadow 的有效模式运行，
 *   状态区明示「正式模式尚未接线」，不许界面宣称合并视图展示中。
 * 缺省 disabled；VITE_RELAY_URL 为空时强制 disabled（无公告栏可读）。
 * 环境变量：VITE_RELAY_MODE = disabled / shadow / active。
 */
export type RelayMode = 'disabled' | 'shadow' | 'active'

export function parseRelayMode(rawMode: unknown, relayUrl: string): RelayMode {
  if (!relayUrl) return 'disabled'
  const raw = String(rawMode ?? '').trim().toLowerCase()
  return raw === 'shadow' || raw === 'active' ? raw : 'disabled'
}

/** 正式模式是否已接线进生产订单簿（阶段 3 接线时改 true 并同步状态区文案） */
export const RELAY_ACTIVE_WIRED = false

/** 请求模式 → 有效模式：active 未接线时降为 shadow（行为与标注一致） */
export function effectiveRelayMode(requested: RelayMode): RelayMode {
  return requested === 'active' && !RELAY_ACTIVE_WIRED ? 'shadow' : requested
}

/** 环境变量请求的模式（可能是尚未接线的 active） */
export const RELAY_MODE_REQUESTED: RelayMode = parseRelayMode(
  import.meta.env.VITE_RELAY_MODE,
  RELAY_URL,
)

/** 全站实际生效的模式（请求 active 未接线时为 shadow） */
export const RELAY_MODE: RelayMode = effectiveRelayMode(RELAY_MODE_REQUESTED)
