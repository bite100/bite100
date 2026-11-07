/**
 * 跨链桥准备区与固定条的状态机（第 31 轮 §12.3，纯函数）：
 * 只有 CCIP / Wormhole 需要先把 TKA 包裹成 WTKA；五态——
 * 未选通道（固定条禁用）→ 选中消息桥但未填数量 → WTKA 不足（待包裹，固定条禁用）
 * → 包裹完成/余额足够（已就绪，固定条可用）→ 确认框（既有流程）。
 */

export type BridgeIdLike = 'layerzero' | 'ccip' | 'wormhole' | 'fastlane' | null

export type PrepState = 'none' | 'pending-amount' | 'need-wrap' | 'ready'

export function needsWrap(bridge: BridgeIdLike): boolean {
  return bridge === 'ccip' || bridge === 'wormhole'
}

export function prepState(bridge: BridgeIdLike, amountWei: bigint, wtkaWei: bigint): PrepState {
  if (!needsWrap(bridge)) return 'none'
  if (amountWei <= 0n) return 'pending-amount'
  return wtkaWei >= amountWei ? 'ready' : 'need-wrap'
}

/** 还差多少 WTKA（wei）；不差为 0 */
export function wrapShortfallWei(amountWei: bigint, wtkaWei: bigint): bigint {
  return amountWei > wtkaWei ? amountWei - wtkaWei : 0n
}

export interface BridgeCta {
  disabled: boolean
  text: string
}

/**
 * 固定条主按钮文案与可用性（设计 §12.3）：
 * 未选通道 → 「先选择通道，再发起转移」；需包裹未完成 → 「先完成包裹，再发起转移」；
 * 其余按既有字段完整性决定（文案为「发起跨链转移」）。
 */
export function bridgeCta(args: {
  bridge: BridgeIdLike
  prep: PrepState
  account: string | null
  hasSource: boolean
  hasTarget: boolean
  hasAmount: boolean
  loading: boolean
}): BridgeCta {
  if (args.loading) return { disabled: true, text: '处理中…' }
  if (!args.bridge) return { disabled: true, text: '先选择通道，再发起转移' }
  if (args.prep === 'need-wrap') return { disabled: true, text: '先完成包裹，再发起转移' }
  const ready =
    Boolean(args.account) && args.hasSource && args.hasTarget && args.hasAmount
  return { disabled: !ready, text: '发起跨链转移' }
}

/** 固定条「预计到账」：已知口径才给数——LZ 从到账扣 0.1 TKA；消息桥载体为 WTKA 1:1；快线以实时报价为准（外部传入） */
export function expectedArrival(args: {
  bridge: BridgeIdLike
  amountText: string
  fastlaneNet?: string | null
}): string {
  const amt = parseFloat(args.amountText)
  const hasAmt = Number.isFinite(amt) && amt > 0
  switch (args.bridge) {
    case 'ccip':
    case 'wormhole':
      return hasAmt ? `${args.amountText} WTKA` : '—'
    case 'layerzero':
      return hasAmt ? `${amt > 0.1 ? (amt - 0.1).toFixed(6).replace(/\.?0+$/, '') : '0'} TKA（已扣 0.1 TKA 桥费）` : '—'
    case 'fastlane':
      return args.fastlaneNet ?? '—'
    default:
      return '—'
  }
}
