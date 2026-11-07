/**
 * 第二十轮：垫资快线 provider（聚合器路线）
 *
 * 定位：在 LayerZero / CCIP / Wormhole 三家「消息桥」之外，提供第四条跨链通道——
 * 求解器/做市商垫付。做市商用自有资金在目的链先付给用户，用户不用等源链最终确认，
 * 做市商事后自行过桥平账。费用含在报价里（从到账额中扣），由选择快线的用户承担。
 *
 * 实现方式（集成优先，只写胶水）：聚合器选定为 **LI.FI**——一次接入其官方 REST API
 * （https://li.quest/v1），即可在其路由内覆盖 Across、Relay、deBridge、Stargate 等
 * 多家做市商/桥。官方 API 原样调用，本文件只做：参数拼装、响应解析、费用拆分、
 * 统一状态映射（对齐 docs/bridge-abstraction.md 的四态）、测试网拦截。
 * 选型对比与核实记录见 docs/round20-fastlane-2026-11-07.md。
 *
 * 测试网诚实原则（硬性）：求解器网络只在主网有真实资金流动性。Sepolia / Base Sepolia
 * 上没有任何做市商为任意代币（如 TKA）垫资。因此本 provider 对测试网链对在**发起
 * 任何网络请求之前**就抛 FastLaneUnavailableError，前端只展示说明、绝不伪造报价。
 * LI.FI 链列表里出现测试网链 ID 不等于测试网有报价/流动性，不作数，以本拦截为准。
 */

export const FASTLANE_ID = 'fastlane' as const
export const FASTLANE_AGGREGATOR_NAME = 'LI.FI'

const LIFI_API_BASE = 'https://li.quest/v1'
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * 首批开通快线的主网链：Ethereum(1) ↔ Base(8453)。
 * 两条链均在 LI.FI 支持列表内（2026-11-07 以 GET /v1/chains 实测读回，共 65 条链）。
 * 其他主网链（Arbitrum / Polygon / Optimism / BSC 等）待逐项核实其路由与代币覆盖后再扩充，
 * 不在本清单内的链对一律按「未开通」处理，不发起报价。
 */
export const FASTLANE_MAINNET_CHAIN_IDS: readonly number[] = [1, 8453]

/** Bit100 已部署的测试网链：快线在这些链上没有流动性，硬拦截。 */
export const FASTLANE_TESTNET_CHAIN_IDS: readonly number[] = [11155111, 84532]

export type FastLaneBlockReason = 'testnet' | 'chain-not-enabled'

export type FastLanePairSupport =
  | { supported: true }
  | { supported: false; reason: FastLaneBlockReason }

/** 判断链对是否可走快线。纯函数，不发网络请求。 */
export function fastLanePairSupport(srcChainId: number, dstChainId: number): FastLanePairSupport {
  if (
    FASTLANE_TESTNET_CHAIN_IDS.includes(srcChainId) ||
    FASTLANE_TESTNET_CHAIN_IDS.includes(dstChainId)
  ) {
    return { supported: false, reason: 'testnet' }
  }
  if (
    !FASTLANE_MAINNET_CHAIN_IDS.includes(srcChainId) ||
    !FASTLANE_MAINNET_CHAIN_IDS.includes(dstChainId) ||
    srcChainId === dstChainId
  ) {
    return { supported: false, reason: 'chain-not-enabled' }
  }
  return { supported: true }
}

/** 快线不可用的用户可读文案（与桥页标注口径一致）。 */
export function fastLaneBlockMessage(reason: FastLaneBlockReason): string {
  return reason === 'testnet'
    ? '极速到账（做市商垫付）是主网功能：求解器网络在测试网没有流动性，当前测试网组合下不可用，也不会发起报价。请改选其余三家桥，或等主网上线后使用。'
    : '极速到账目前只开通 Ethereum ↔ Base 主网方向，其他主网链陆续接入中。'
}

export class FastLaneUnavailableError extends Error {
  readonly reason: FastLaneBlockReason
  constructor(reason: FastLaneBlockReason) {
    super(fastLaneBlockMessage(reason))
    this.name = 'FastLaneUnavailableError'
    this.reason = reason
  }
}

/**
 * 知名代币在各链的地址族：用户在源链选了某代币，目的链自动配同名资产。
 * 地址取自各代币发行方公开部署（USDC = Circle，WETH = 各链官方包装合约）。
 * 不在表内的代币默认两链同地址（由 LI.FI 校验，无此路由时报价直接失败，不伪造）。
 */
const TOKEN_FAMILIES: Record<number, string>[] = [
  // USDC（Circle 原生发行）
  { 1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  // WETH
  { 1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 8453: '0x4200000000000000000000000000000000000006' },
]

/** 由源链代币地址推目的链对应代币地址；原生币（零地址）两链同为零地址。 */
export function resolveFastLaneTokenPair(
  srcChainId: number,
  dstChainId: number,
  srcToken: string
): [string, string] {
  const from = srcToken && srcToken !== '' ? srcToken : ZERO_ADDRESS
  if (from.toLowerCase() === ZERO_ADDRESS) return [ZERO_ADDRESS, ZERO_ADDRESS]
  for (const family of TOKEN_FAMILIES) {
    const srcAddr = family[srcChainId]
    if (srcAddr && srcAddr.toLowerCase() === from.toLowerCase() && family[dstChainId]) {
      return [from, family[dstChainId]]
    }
  }
  return [from, from]
}

export interface FastLaneFeeItem {
  /** 费用名（LI.FI 原样，如协议名 + 'Fee'） */
  name: string
  /** 最小单位金额 */
  amount: bigint
  symbol: string
  decimals: number
  amountUSD?: string
}

export interface FastLaneTransactionRequest {
  to: string
  data: string
  value: string
  chainId?: number
  gasLimit?: string
}

/** 解析后的统一报价（对齐 bridge-abstraction 的费用三分口径，面向前端展示）。 */
export interface FastLaneQuote {
  /** LI.FI 报价 ID */
  id: string
  /** 实际履约方名称（报价返回的工具名，如 Relay / Across / deBridge） */
  routeTool: string
  fromAmount: bigint
  /** 预计到账净额（已扣除从到账内扣的费用） */
  netReceived: bigint
  /** 最低到账（低于此数不执行） */
  toAmountMin: bigint
  fromTokenSymbol: string
  toTokenSymbol: string
  toTokenDecimals: number
  /** 预计到账秒数（报价返回的 executionDuration） */
  etaSeconds: number
  /** 从到账额中扣除的费用（做市商/协议/聚合器服务费） */
  deductedFees: FastLaneFeeItem[]
  /** 需在发送时额外支付的费用（一般为空，个别路由有） */
  upfrontFees: FastLaneFeeItem[]
  /** 发送交易的 gas 成本（源链原生币支付，不从到账扣除） */
  gasCosts: FastLaneFeeItem[]
  /** ERC20 授权目标（LI.FI 返回的 approvalAddress） */
  approvalAddress?: string
  /** 可直接签名的交易（LI.FI 返回的 transactionRequest，原样透传） */
  transactionRequest?: FastLaneTransactionRequest
  raw: unknown
}

export type FastLaneUnifiedState = 'Initiated' | 'InFlight' | 'Completed' | 'Failed'

export interface FastLaneStatus {
  state: FastLaneUnifiedState
  dstTxHash?: string
  receivedAmount?: bigint
  raw: unknown
}

type Fetcher = typeof fetch

function lifiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' }
  // API key / integrator 均为可选：无 key 时走官方免 key 通道（限流较紧，实测易 429）；
  // 主网上线前由 Ren 在 LI.FI Partner Portal 免费申请 key 后填入 VITE_LIFI_API_KEY。
  const apiKey = (import.meta.env.VITE_LIFI_API_KEY ?? '').trim()
  if (apiKey) headers['x-lifi-api-key'] = apiKey
  return headers
}

function integratorParam(): string | null {
  const s = (import.meta.env.VITE_LIFI_INTEGRATOR ?? '').trim()
  return s ? s : null
}

function toFeeItem(f: any): FastLaneFeeItem {
  return {
    name: String(f?.name ?? 'Fee'),
    amount: BigInt(f?.amount ?? '0'),
    symbol: String(f?.token?.symbol ?? ''),
    decimals: Number(f?.token?.decimals ?? 18),
    amountUSD: f?.amountUSD != null ? String(f.amountUSD) : undefined,
  }
}

/** 把 LI.FI 原始报价响应解析为统一报价。纯函数，便于单测。 */
export function parseLifiQuote(d: any): FastLaneQuote {
  const estimate = d?.estimate ?? {}
  const feeCosts: any[] = Array.isArray(estimate.feeCosts) ? estimate.feeCosts : []
  const gasCosts: any[] = Array.isArray(estimate.gasCosts) ? estimate.gasCosts : []
  const txReq = d?.transactionRequest
  return {
    id: String(d?.id ?? ''),
    routeTool: String(d?.toolDetails?.name ?? d?.tool ?? '求解器网络'),
    fromAmount: BigInt(d?.action?.fromAmount ?? estimate.fromAmount ?? '0'),
    netReceived: BigInt(estimate.toAmount ?? '0'),
    toAmountMin: BigInt(estimate.toAmountMin ?? estimate.toAmount ?? '0'),
    fromTokenSymbol: String(d?.action?.fromToken?.symbol ?? ''),
    toTokenSymbol: String(d?.action?.toToken?.symbol ?? ''),
    toTokenDecimals: Number(d?.action?.toToken?.decimals ?? 18),
    etaSeconds: Number(estimate.executionDuration ?? 0),
    deductedFees: feeCosts.filter((f) => f?.included).map(toFeeItem),
    upfrontFees: feeCosts.filter((f) => !f?.included).map(toFeeItem),
    gasCosts: gasCosts.map(toFeeItem),
    approvalAddress: d?.estimate?.approvalAddress ?? d?.approvalAddress,
    transactionRequest: txReq
      ? {
          to: String(txReq.to),
          data: String(txReq.data),
          value: String(txReq.value ?? '0'),
          chainId: txReq.chainId != null ? Number(txReq.chainId) : undefined,
          gasLimit: txReq.gasLimit != null ? String(txReq.gasLimit) : undefined,
        }
      : undefined,
    raw: d,
  }
}

export interface FastLaneQuoteRequest {
  srcChainId: number
  dstChainId: number
  fromToken: string
  toToken: string
  amountWei: bigint
  fromAddress: string
  /** 收款地址（默认 = fromAddress） */
  toAddress?: string
}

/**
 * 实时报价：调用 LI.FI 官方 GET /v1/quote。
 * 测试网/未开通链对在发请求前抛 FastLaneUnavailableError，绝不发请求、绝不编造报价。
 */
export async function fetchFastLaneQuote(
  req: FastLaneQuoteRequest,
  fetcher: Fetcher = fetch
): Promise<FastLaneQuote> {
  const support = fastLanePairSupport(req.srcChainId, req.dstChainId)
  if (!support.supported) throw new FastLaneUnavailableError(support.reason)

  const params = new URLSearchParams({
    fromChain: String(req.srcChainId),
    toChain: String(req.dstChainId),
    fromToken: req.fromToken,
    toToken: req.toToken,
    fromAmount: req.amountWei.toString(),
    fromAddress: req.fromAddress,
    toAddress: req.toAddress ?? req.fromAddress,
  })
  const integrator = integratorParam()
  if (integrator) params.set('integrator', integrator)

  const res = await fetcher(`${LIFI_API_BASE}/quote?${params.toString()}`, {
    method: 'GET',
    headers: lifiHeaders(),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const msg =
      (body && typeof body.message === 'string' && body.message) ||
      `LI.FI 报价请求失败（HTTP ${res.status}）`
    throw new Error(msg)
  }
  return parseLifiQuote(body)
}

/** 把 LI.FI 状态端点状态映射到统一四态。纯函数，便于单测。 */
export function mapLifiStatus(d: any): FastLaneStatus {
  const status = String(d?.status ?? '')
  const receiving = d?.receiving ?? {}
  const receivedAmount =
    receiving.amount != null ? BigInt(receiving.amount) : undefined
  switch (status) {
    case 'DONE':
      return { state: 'Completed', dstTxHash: receiving.txHash, receivedAmount, raw: d }
    case 'FAILED':
    case 'INVALID':
      return { state: 'Failed', raw: d }
    case 'PENDING':
      return { state: 'InFlight', raw: d }
    case 'NOT_FOUND':
    default:
      // 刚发出、聚合器尚未索引到：记为已发起，不谎报进度
      return { state: 'Initiated', raw: d }
  }
}

/** 状态追踪：调用 LI.FI 官方 GET /v1/status（按发送交易哈希查）。 */
export async function fetchFastLaneStatus(
  req: { txHash: string; srcChainId: number; dstChainId: number },
  fetcher: Fetcher = fetch
): Promise<FastLaneStatus> {
  const support = fastLanePairSupport(req.srcChainId, req.dstChainId)
  if (!support.supported) throw new FastLaneUnavailableError(support.reason)
  const params = new URLSearchParams({
    txHash: req.txHash,
    fromChain: String(req.srcChainId),
    toChain: String(req.dstChainId),
  })
  const res = await fetcher(`${LIFI_API_BASE}/status?${params.toString()}`, {
    method: 'GET',
    headers: lifiHeaders(),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const msg =
      (body && typeof body.message === 'string' && body.message) ||
      `LI.FI 状态查询失败（HTTP ${res.status}）`
    throw new Error(msg)
  }
  return mapLifiStatus(body)
}

/** 预计到账时间的人类可读文案（分钟级口径）。 */
export function formatFastLaneEta(etaSeconds: number): string {
  if (!etaSeconds || etaSeconds <= 0) return '以实时报价为准'
  if (etaSeconds < 90) return '约 1 分钟内'
  const mins = Math.max(1, Math.round(etaSeconds / 60))
  return `约 ${mins} 分钟`
}
