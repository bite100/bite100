import { useState, useCallback, useEffect } from 'react'
import { Contract, ZeroAddress, AbiCoder, zeroPadValue, formatUnits } from 'ethers'
import { SUPPORTED_CHAINS, getChainConfig } from '../config/chains'
import {
  fetchFastLaneQuote,
  fetchFastLaneStatus,
  fastLanePairSupport,
  fastLaneBlockMessage,
  resolveFastLaneTokenPair,
  formatFastLaneEta,
  type FastLaneQuote,
} from '../services/fastLane'
import { getProvider, withSigner, formatTokenAmount, formatError } from '../utils'
import { ErrorDisplay } from './ErrorDisplay'
import { ERC20_ABI } from '../config'
import './CrossChainBridge.css'

interface CrossChainBridgeProps {
  account: string | null
  currentChainId: number | null
}

const CROSS_CHAIN_BRIDGE_ABI = [
  'function bridgeToken(address token, uint256 amount, uint32 dstEid, bytes calldata options) payable returns (uint256 transferId, bytes32 guid)',
  'function quoteBridgeFee(address token, uint256 amount, uint32 dstEid, address user, bytes calldata options) view returns (uint256 nativeFee, uint256 lzTokenFee)',
  'function supportedTokens(address token) view returns (bool)',
  'function tokenMapping(uint32 dstEid, address token) view returns (address)',
  'function getBridgeStatus(bytes32 guid) view returns (uint8 status, uint256 transferId, uint256 initiatedAt, uint256 completedAt, uint256 attempts)',
  'function retryBridge(uint256 transferId, bytes calldata options) payable returns (bytes32 guid)',
  'event BridgeInitiated(bytes32 indexed guid, uint256 indexed transferId, address indexed user, address token, uint256 amount, uint32 dstEid)',
  'event BridgeStatusUpdated(uint256 indexed transferId, uint8 status, uint256 timestamp)',
] as const

// WrappedTKA：在 ERC20 之外只需 wrap（TKA -> wTKA，1:1）
const WRAPPED_TOKEN_ABI = [...ERC20_ABI, 'function wrap(uint256 amount)'] as const

// Chainlink CCIP 官方 Router（JSON ABI，含 tuple 结构）
const CCIP_ROUTER_ABI = [
  {
    type: 'function',
    name: 'getFee',
    stateMutability: 'view',
    inputs: [
      { name: 'destinationChainSelector', type: 'uint64' },
      {
        name: 'message',
        type: 'tuple',
        components: [
          { name: 'receiver', type: 'bytes' },
          { name: 'data', type: 'bytes' },
          {
            name: 'tokenAmounts',
            type: 'tuple[]',
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
          { name: 'extraArgs', type: 'bytes' },
          { name: 'feeToken', type: 'address' },
        ],
      },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'ccipSend',
    stateMutability: 'payable',
    inputs: [
      { name: 'destinationChainSelector', type: 'uint64' },
      {
        name: 'message',
        type: 'tuple',
        components: [
          { name: 'receiver', type: 'bytes' },
          { name: 'data', type: 'bytes' },
          {
            name: 'tokenAmounts',
            type: 'tuple[]',
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
          { name: 'extraArgs', type: 'bytes' },
          { name: 'feeToken', type: 'address' },
        ],
      },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

// CCIP ExtraArgs V3 基本编码：tag 0xa69dd4aa + gasLimit(uint32=0) + 最终性(bytes4=0，默认) + 7 字节保留
const CCIP_EXTRA_ARGS_V3_BASIC = '0xa69dd4aa' + '00'.repeat(15)

// Wormhole 官方 NTT Manager 与核心桥
const NTT_MANAGER_ABI = [
  'function transfer(uint256 amount, uint16 recipientChain, bytes32 recipient, bytes32 refundAddress, bool shouldQueue, bytes encodedInstructions) payable returns (uint64 msgId)',
] as const
const WORMHOLE_CORE_ABI = ['function messageFee() view returns (uint256)'] as const
// NTT 单个 Wormhole Transceiver 的标准空指令编码（计数 1 + index 0 + 长度 0）
const NTT_SINGLE_TRANSCEIVER_INSTRUCTIONS = '0x010000'

// LayerZero EID（Endpoint ID）映射
const LAYERZERO_EIDS: Record<number, number> = {
  1: 30101,        // Ethereum Mainnet
  8453: 30184,     // Base Mainnet
  42161: 30110,    // Arbitrum One
  137: 30109,       // Polygon
  10: 30111,       // Optimism
  11155111: 40161, // Sepolia
  84532: 40245,    // Base Sepolia
  421614: 40231,   // Arbitrum Sepolia
}

type BridgeId = 'layerzero' | 'ccip' | 'wormhole' | 'fastlane'

interface BridgeMeta {
  id: BridgeId
  name: string
  feeSummary: string
  etaSummary: string
  securitySummary: string
  riskPoints: string[]
}

const BRIDGE_METAS: BridgeMeta[] = [
  {
    id: 'layerzero',
    name: 'LayerZero',
    feeSummary: '费用发送时实时报价：以源链 ETH 支付跨链消息费，另有 0.1 TKA 桥费从到账数量中扣除',
    etaSummary: '预计 10–20 分钟到账（预估，视源链确认速度而定）',
    securitySummary: '验证方：LayerZero 网络的 DVN 验证——⚠ 当前只有 1 个验证方（1-of-1 配置）',
    riskPoints: [
      '当前验证方是 1-of-1：跨链消息只由一个验证方（LayerZero Labs 的 DVN）签字确认，没有第二个独立验证方复核。这个验证方若被攻破或作恶，假消息也可能被放行。',
      '业界先例：2026 年 4 月 KelpDAO 约 2.92 亿美元损失事件中，涉事跨链路径正是 1-of-1 DVN 配置。本站已定硬门禁：主网开放此桥之前，必须先升级为多验证方配置并读回核实。',
      '当前仅测试网。大额资金请勿使用此通道，等多验证方配置落地后再考虑。',
    ],
  },
  {
    id: 'ccip',
    name: 'Chainlink CCIP',
    feeSummary: '费用发送前由 Chainlink 报价并在发送时锁定（固定价）：以源链 ETH 支付，不另收桥费',
    etaSummary: '预计 10–20 分钟到账（预估，含源链最终性等待）',
    securitySummary: '验证方：Chainlink 去中心化预言机网络（DON）提交，另有独立的风险管理网络（RMN）监控，异常时可自动熔断',
    riskPoints: [
      '费用在发送前报价、发送时锁定，中途不补差价；报价有效期短，价格变化后需要重新报价再发。',
      '跨链消息由 Chainlink 的 DON 网络验证、RMN 独立复核，是三家中验证层最厚的；但智能合约与预言机网络风险仍然存在，跨链转账不可撤销。',
      '当前仅测试网（Sepolia ↔ Base Sepolia），代币池限额为测试规模（单向桶容量 100,000 wTKA）。',
    ],
  },
  {
    id: 'wormhole',
    name: 'Wormhole（NTT）',
    feeSummary: '测试网消息费为 0：只需付发送交易本身的 ETH gas，不另收桥费',
    etaSummary: '预计 15–25 分钟到账（预估，要等源链完全确认 + Guardian 签名）',
    securitySummary: '验证方：Wormhole 的 19 个 Guardian 节点，至少 13 个签名（13-of-19）消息才被放行',
    riskPoints: [
      '13-of-19 多签模型：单个节点作恶无法放行假消息，需要过半数 Guardian 串通才可能出问题。',
      '历史上 2022 年 Wormhole 曾因 Solana 侧验签漏洞被盗约 12 万 ETH——那是 Solana 侧组件，与本次 EVM 侧 NTT 配置不是同一组件；但它说明跨链桥整体属于高风险类别，请先小额试走。',
      '若目标链长时间未自动到账，可能需要凭消息证明（VAA）在目标链手动完成投递，桥页下方有查询入口与说明。',
    ],
  },
  {
    id: 'fastlane',
    name: '极速到账（做市商垫付）',
    feeSummary: '主网实时报价（经 LI.FI 聚合多家做市商/桥选路）：做市商与协议费用从到账数量中扣除，发送交易的 gas 以源链原生币另付；点确认前会把每一项拆开展示',
    etaSummary: '主网预计约 1–5 分钟到账（以实时报价为准；做市商在目的链先行垫付，不用等源链最终确认）',
    securitySummary: '安全模型：没有跨链消息验证环节——做市商用自有资金在目的链先付给你，事后自行过桥平账；你面对的是报价与履约风险，不是验证方作恶风险',
    riskPoints: [
      '主网功能，测试网不可用：做市商只在主网有真实资金流动性，Sepolia / Base Sepolia 上没有人垫资。此选项在测试网组合下只展示说明，不发起报价、不接受发起，页面上也不会出现编造的报价数字。',
      '费用从到账里扣：报价即最终口径——预计到账与最低到账都会在确认前展示；做市商利润、聚合器（LI.FI）服务费与协议费都包含在报价差额中，发送交易的 gas 以源链原生币另付。',
      '履约方以报价为准：聚合器会在多家做市商/桥之间选路（可能经 Across、Relay、deBridge 等履约），实际履约方名称会显示在报价里；对方先在目的链付款，你不需要等源链最终确认。',
      '若无人接单或长时间未到账：不要重复发送同一笔。先凭发送交易哈希在本页或 LI.FI Explorer 查状态；未履约的按履约方机制处理（继续等待或退款路径），也可以改走本页其余三家消息桥重新发起——务必先确认原单状态再发新单，避免重复转移。',
      '跨链转账不可撤销；报价有有效期，过期或价格变化后需要重新报价，以重新报价的数字为准。',
    ],
  },
]

function parseAmountToWei(amount: string): bigint {
  const n = parseFloat(amount)
  if (!isFinite(n) || n <= 0) return 0n
  return BigInt(Math.floor(n * 1e18))
}

// 快线报价一句话（卡片展示）：履约方 / 预计到账 / 从到账扣除的费用 / 另付 gas / 预计时效
function formatFastLaneQuoteLine(q: FastLaneQuote): string {
  const net = formatUnits(q.netReceived, q.toTokenDecimals)
  const feeText = q.deductedFees.length
    ? q.deductedFees.map((f) => `${formatUnits(f.amount, f.decimals)} ${f.symbol}`).join(' + ')
    : '0'
  const gasText = q.gasCosts.length
    ? `；gas 约 ${q.gasCosts.map((g) => `${formatUnits(g.amount, g.decimals)} ${g.symbol}`).join(' + ')} 另付`
    : ''
  return `实时报价（经 ${q.routeTool} 履约）：预计到账 ${net} ${q.toTokenSymbol}；费用 ${feeText} 从到账扣除${gasText}；${formatFastLaneEta(q.etaSeconds)}到账`
}

export function CrossChainBridge({ account, currentChainId }: CrossChainBridgeProps) {
  const [sourceChainId, setSourceChainId] = useState<number | null>(currentChainId)
  const [targetChainId, setTargetChainId] = useState<number | null>(null)
  // 不预选任何一家桥：必须由用户主动点选（尤其是不能默认到风险最高的 LayerZero 1-of-1 通道）
  const [selectedBridge, setSelectedBridge] = useState<BridgeId | null>(null)
  const [tokenAddress, setTokenAddress] = useState<string>('')
  const [amount, setAmount] = useState<string>('')
  const [balance, setBalance] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [customBridgeAddress, setCustomBridgeAddress] = useState<string>('')
  const [showConfirm, setShowConfirm] = useState(false)
  // 桥合约地址默认取源链配置（config/chains.ts 的 crossChainBridge）；输入框填了自定义地址时以输入为准
  const configuredBridge = sourceChainId ? getChainConfig(sourceChainId)?.contracts.crossChainBridge : undefined
  const bridgeAddress =
    customBridgeAddress || (configuredBridge && configuredBridge !== ZeroAddress ? configuredBridge : '')
  const [quotes, setQuotes] = useState<Partial<Record<BridgeId, string>>>({})
  const [bridgeStatus, setBridgeStatus] = useState<string>('')
  const [lastRequestId, setLastRequestId] = useState<string | null>(null)
  const [ccipMessageId, setCcipMessageId] = useState<string | null>(null)
  const [wormholeTxHash, setWormholeTxHash] = useState<string | null>(null)
  const [fastLaneQuote, setFastLaneQuote] = useState<FastLaneQuote | null>(null)
  const [fastlaneTxHash, setFastlaneTxHash] = useState<string | null>(null)

  const sourceChain = sourceChainId ? getChainConfig(sourceChainId) : null
  const targetChain = targetChainId ? getChainConfig(targetChainId) : null
  const selectedMeta = BRIDGE_METAS.find((b) => b.id === selectedBridge) || null

  // CCIP / Wormhole 的载体代币是 wTKA，用户持有的是 TKA：这两家桥固定以源链 TKA 为输入，
  // 发起时自动把 TKA 按 1:1 换成 wTKA 再发送（见 execute 流程）；LayerZero 保持原有自由代币输入。
  const effectiveToken =
    selectedBridge === 'ccip' || selectedBridge === 'wormhole'
      ? sourceChain?.contracts.token0 || ''
      : tokenAddress

  const bridgeAvailable = useCallback(
    (id: BridgeId): boolean => {
      if (!sourceChain || !targetChain) return false
      if (id === 'layerzero') return Boolean(bridgeAddress) && Boolean(LAYERZERO_EIDS[targetChain.chainId])
      if (id === 'ccip') return Boolean(sourceChain.ccip && targetChain.ccip && sourceChain.contracts.wrappedToken)
      if (id === 'fastlane') return fastLanePairSupport(sourceChain.chainId, targetChain.chainId).supported
      return Boolean(sourceChain.wormhole && targetChain.wormhole && sourceChain.contracts.wrappedToken)
    },
    [sourceChain, targetChain, bridgeAddress]
  )

  // 获取余额（按当前所选桥的有效代币）
  const fetchBalance = useCallback(async () => {
    if (!account || !effectiveToken || !sourceChainId) {
      setBalance('0')
      return
    }
    try {
      const provider = getProvider()
      if (!provider) return
      const token = new Contract(effectiveToken, ERC20_ABI, provider)
      const bal = await token.balanceOf(account)
      setBalance(formatTokenAmount(bal))
    } catch (e) {
      setBalance('0')
    }
  }, [account, effectiveToken, sourceChainId])

  useEffect(() => {
    fetchBalance()
  }, [fetchBalance])

  // 三家桥的实时报价（选好源链/目标链/数量后并行刷新，展示在各自卡片上）
  const refreshQuotes = useCallback(async () => {
    const amountWei = parseAmountToWei(amount)
    if (!sourceChain || !targetChain || amountWei === 0n || !account) {
      setQuotes({})
      return
    }
    const provider = getProvider()
    if (!provider) return
    const next: Partial<Record<BridgeId, string>> = {}

    if (bridgeAvailable('layerzero')) {
      try {
        const bridge = new Contract(bridgeAddress, CROSS_CHAIN_BRIDGE_ABI, provider)
        const quoteToken = tokenAddress || sourceChain.contracts.token0
        const [nativeFee] = await bridge.quoteBridgeFee(
          quoteToken,
          amountWei,
          LAYERZERO_EIDS[targetChain.chainId],
          account,
          '0x'
        )
        next.layerzero = `实时报价：${formatTokenAmount(nativeFee)} ETH（发送时支付）+ 0.1 TKA 桥费（从到账扣除）`
      } catch {
        next.layerzero = '实时报价暂时获取失败，发送前仍会重新报价'
      }
    }

    if (bridgeAvailable('ccip') && sourceChain.ccip && targetChain.ccip) {
      try {
        const router = new Contract(sourceChain.ccip.router, CCIP_ROUTER_ABI, provider)
        const message = {
          receiver: AbiCoder.defaultAbiCoder().encode(['address'], [account]),
          data: '0x',
          tokenAmounts: [{ token: sourceChain.contracts.wrappedToken!, amount: amountWei }],
          extraArgs: CCIP_EXTRA_ARGS_V3_BASIC,
          feeToken: ZeroAddress,
        }
        const fee: bigint = await router.getFee(BigInt(targetChain.ccip.chainSelector), message)
        next.ccip = `实时报价：${formatTokenAmount(fee)} ETH（发送时锁定，不补差价）`
      } catch {
        next.ccip = '实时报价暂时获取失败，发送前仍会重新报价'
      }
    }

    if (bridgeAvailable('wormhole') && sourceChain.wormhole) {
      try {
        const core = new Contract(sourceChain.wormhole.coreBridge, WORMHOLE_CORE_ABI, provider)
        const fee: bigint = await core.messageFee()
        next.wormhole =
          fee === 0n
            ? '实时报价：消息费 0 ETH（另付发送交易的 gas）'
            : `实时报价：消息费 ${formatTokenAmount(fee)} ETH（另付发送交易的 gas）`
      } catch {
        next.wormhole = '实时报价暂时获取失败，发送前仍会重新报价'
      }
    }

    // 快线报价由独立的防抖刷新维护（见 refreshFastLaneQuote），这里保留不覆盖
    setQuotes((prev) => ({ ...next, fastlane: prev.fastlane }))
  }, [amount, sourceChain, targetChain, account, bridgeAvailable, bridgeAddress, tokenAddress])

  useEffect(() => {
    refreshQuotes()
  }, [refreshQuotes])

  // 快线实时报价（LI.FI）：防抖 800ms，避免每次按键都打聚合器 API（免 key 通道限流紧）。
  // 链对不可用时（测试网/未开通）不调用报价服务，卡片只显示静态说明，绝不出现编造数字。
  const refreshFastLaneQuote = useCallback(async () => {
    const amountWei = parseAmountToWei(amount)
    if (!sourceChain || !targetChain || amountWei === 0n || !account || !bridgeAvailable('fastlane')) {
      setFastLaneQuote(null)
      return
    }
    try {
      const [fromToken, toToken] = resolveFastLaneTokenPair(
        sourceChain.chainId,
        targetChain.chainId,
        tokenAddress || ZeroAddress
      )
      const q = await fetchFastLaneQuote({
        srcChainId: sourceChain.chainId,
        dstChainId: targetChain.chainId,
        fromToken,
        toToken,
        amountWei,
        fromAddress: account,
      })
      setFastLaneQuote(q)
      setQuotes((prev) => ({ ...prev, fastlane: formatFastLaneQuoteLine(q) }))
    } catch {
      setFastLaneQuote(null)
      setQuotes((prev) => ({
        ...prev,
        fastlane: '实时报价暂时获取失败（聚合器限流或该代币暂无路由），发送前仍会重新报价，报价失败不会执行',
      }))
    }
  }, [amount, sourceChain, targetChain, account, bridgeAvailable, tokenAddress])

  useEffect(() => {
    const t = setTimeout(() => {
      void refreshFastLaneQuote()
    }, 800)
    return () => clearTimeout(t)
  }, [refreshFastLaneQuote])

  // 快线状态轮询（LI.FI /v1/status，统一四态映射）
  const checkFastLaneStatus = useCallback(async () => {
    if (!fastlaneTxHash || !sourceChainId || !targetChainId) return
    try {
      const s = await fetchFastLaneStatus({
        txHash: fastlaneTxHash,
        srcChainId: sourceChainId,
        dstChainId: targetChainId,
      })
      if (s.state === 'Completed')
        setBridgeStatus(`极速到账已完成${s.dstTxHash ? `：目的链交易 ${s.dstTxHash}` : ''}`)
      else if (s.state === 'Failed')
        setBridgeStatus('极速到账状态：未完成/失败，请凭发送交易哈希在 LI.FI Explorer 查询处理')
      else if (s.state === 'InFlight') setBridgeStatus('极速到账处理中：做市商履约中…')
      else setBridgeStatus('极速到账已发起，等待履约方接单…')
    } catch {
      // 状态查询失败不打断页面，下个周期重试
    }
  }, [fastlaneTxHash, sourceChainId, targetChainId])

  useEffect(() => {
    if (!fastlaneTxHash) return
    const interval = setInterval(() => {
      void checkFastLaneStatus()
    }, 15000)
    return () => clearInterval(interval)
  }, [fastlaneTxHash, checkFastLaneStatus])

  // LayerZero 状态查询（既有逻辑）
  const checkBridgeStatus = useCallback(async (requestId: string) => {
    if (!bridgeAddress || !requestId) return
    try {
      const provider = getProvider()
      if (!provider) return
      const bridge = new Contract(bridgeAddress, CROSS_CHAIN_BRIDGE_ABI, provider)
      const [status, , , , attempts] = await bridge.getBridgeStatus(requestId)
      const statusMap: Record<number, string> = { 0: '待处理', 1: '处理中', 2: '已完成', 3: '失败' }
      setBridgeStatus(`LayerZero 状态：${statusMap[Number(status)] || '未知'} · 已尝试 ${attempts} 次`)
    } catch (e) {
      console.error('查询状态失败:', e)
    }
  }, [bridgeAddress])

  useEffect(() => {
    if (!bridgeAddress || !lastRequestId) return
    const interval = setInterval(() => {
      checkBridgeStatus(lastRequestId)
    }, 10000)
    return () => clearInterval(interval)
  }, [bridgeAddress, lastRequestId, checkBridgeStatus])

  // CCIP / Wormhole 共用：把 TKA 按 1:1 换成 wTKA（只补差额部分）
  const wrapShortfall = async (signer: any, amountWei: bigint) => {
    const tkaAddress = sourceChain!.contracts.token0
    const wtkaAddress = sourceChain!.contracts.wrappedToken!
    const wtka = new Contract(wtkaAddress, WRAPPED_TOKEN_ABI, signer)
    const current: bigint = await wtka.balanceOf(account)
    if (current >= amountWei) return
    const shortfall = amountWei - current
    const tka = new Contract(tkaAddress, ERC20_ABI, signer)
    const allowance: bigint = await tka.allowance(account, wtkaAddress)
    if (allowance < shortfall) {
      const tx = await tka.approve(wtkaAddress, shortfall)
      await tx.wait()
    }
    const wrapTx = await wtka.wrap(shortfall)
    await wrapTx.wait()
  }

  const executeLayerzero = async (amountWei: bigint) => {
    await withSigner(async (signer) => {
      if (!bridgeAddress) throw new Error('跨链桥合约地址未配置')
      const token = new Contract(effectiveToken, ERC20_ABI, signer)
      const allowance = await token.allowance(account, bridgeAddress)
      if (allowance < amountWei) {
        const approveTx = await token.approve(bridgeAddress, amountWei)
        await approveTx.wait()
      }
      const bridge = new Contract(bridgeAddress, CROSS_CHAIN_BRIDGE_ABI, signer)
      const dstEid = LAYERZERO_EIDS[targetChainId!]
      if (!dstEid) throw new Error(`目标链 ${targetChainId} 暂不支持跨链（无 LayerZero EID 配置）`)
      const [nativeFee] = await bridge.quoteBridgeFee(effectiveToken, amountWei, dstEid, account, '0x')
      const tx = await bridge.bridgeToken(effectiveToken, amountWei, dstEid, '0x', { value: nativeFee })
      const receipt = await tx.wait()
      if (receipt.status !== 1) throw new Error('跨链交易未成功')
      const initiated = receipt.logs.find((log: any) => {
        try {
          return bridge.interface.parseLog(log)?.name === 'BridgeInitiated'
        } catch {
          return false
        }
      })
      if (initiated) {
        const parsed = bridge.interface.parseLog(initiated)
        const requestId = parsed?.args[0]
        if (requestId) {
          setLastRequestId(requestId)
          setBridgeStatus('LayerZero 转移已发起，等待目标链确认…')
        }
      }
      if (!initiated) setBridgeStatus('LayerZero 转移已发起，请等待目标链确认')
    })
  }

  const executeCcip = async (amountWei: bigint) => {
    await withSigner(async (signer) => {
      const src = sourceChain!
      const dst = targetChain!
      await wrapShortfall(signer, amountWei)
      const wtkaAddress = src.contracts.wrappedToken!
      const router = new Contract(src.ccip!.router, CCIP_ROUTER_ABI, signer)
      const wtka = new Contract(wtkaAddress, ERC20_ABI, signer)
      const allowance: bigint = await wtka.allowance(account, src.ccip!.router)
      if (allowance < amountWei) {
        const tx = await wtka.approve(src.ccip!.router, amountWei)
        await tx.wait()
      }
      const message = {
        receiver: AbiCoder.defaultAbiCoder().encode(['address'], [account!]),
        data: '0x',
        tokenAmounts: [{ token: wtkaAddress, amount: amountWei }],
        extraArgs: CCIP_EXTRA_ARGS_V3_BASIC,
        feeToken: ZeroAddress,
      }
      const selector = BigInt(dst.ccip!.chainSelector)
      const fee: bigint = await router.getFee(selector, message)
      // 先用静态调用取消息 ID（与真实发送同一状态下计算，结果一致），再正式发送
      const messageId: string = await router.ccipSend.staticCall(selector, message, { value: fee })
      const tx = await router.ccipSend(selector, message, { value: fee })
      const receipt = await tx.wait()
      if (receipt.status !== 1) throw new Error('跨链交易未成功')
      setCcipMessageId(messageId)
      setBridgeStatus('CCIP 转移已发起，等待 Chainlink 网络投递到目标链…')
    })
  }

  const executeWormhole = async (amountWei: bigint) => {
    await withSigner(async (signer) => {
      const src = sourceChain!
      const dst = targetChain!
      await wrapShortfall(signer, amountWei)
      const wtkaAddress = src.contracts.wrappedToken!
      const manager = new Contract(src.wormhole!.nttManager, NTT_MANAGER_ABI, signer)
      const wtka = new Contract(wtkaAddress, ERC20_ABI, signer)
      const allowance: bigint = await wtka.allowance(account, src.wormhole!.nttManager)
      if (allowance < amountWei) {
        const tx = await wtka.approve(src.wormhole!.nttManager, amountWei)
        await tx.wait()
      }
      const core = new Contract(src.wormhole!.coreBridge, WORMHOLE_CORE_ABI, signer)
      const fee: bigint = await core.messageFee()
      const recipient = zeroPadValue(account!, 32)
      const tx = await manager.transfer(
        amountWei,
        dst.wormhole!.wormholeChainId,
        recipient,
        recipient,
        false,
        NTT_SINGLE_TRANSCEIVER_INSTRUCTIONS,
        { value: fee }
      )
      const receipt = await tx.wait()
      if (receipt.status !== 1) throw new Error('跨链交易未成功')
      setWormholeTxHash(receipt.hash)
      setBridgeStatus('Wormhole 转移已发起，等待 Guardian 签名与目标链投递…')
    })
  }

  // 快线执行：发送前重新取一次实时报价（报价过期/失败即中止，绝不用旧报价执行），
  // 然后按 LI.FI 返回的 transactionRequest 原样签名发送（官方件原样用，胶水只管授权与透传）。
  const executeFastlane = async (amountWei: bigint) => {
    await withSigner(async (signer) => {
      const src = sourceChain!
      const dst = targetChain!
      const [fromToken, toToken] = resolveFastLaneTokenPair(
        src.chainId,
        dst.chainId,
        tokenAddress || ZeroAddress
      )
      const q = await fetchFastLaneQuote({
        srcChainId: src.chainId,
        dstChainId: dst.chainId,
        fromToken,
        toToken,
        amountWei,
        fromAddress: account!,
      })
      const txReq = q.transactionRequest
      if (!txReq) throw new Error('报价未返回可执行交易，请重新报价后再试')
      if (fromToken !== ZeroAddress) {
        const token = new Contract(fromToken, ERC20_ABI, signer)
        const spender = q.approvalAddress || txReq.to
        const allowance: bigint = await token.allowance(account, spender)
        if (allowance < amountWei) {
          const approveTx = await token.approve(spender, amountWei)
          await approveTx.wait()
        }
      }
      const tx = await signer.sendTransaction({
        to: txReq.to,
        data: txReq.data,
        value: BigInt(txReq.value || '0'),
      })
      const receipt = await tx.wait()
      if (!receipt || receipt.status !== 1) throw new Error('跨链交易未成功')
      setFastLaneQuote(q)
      setFastlaneTxHash(receipt.hash)
      setBridgeStatus(`极速到账已发起（经 ${q.routeTool} 履约），做市商正在目的链垫付…`)
    })
  }

  const handleConfirmExecute = useCallback(async () => {
    setShowConfirm(false)
    const amountWei = parseAmountToWei(amount)
    if (amountWei === 0n || !selectedBridge) return
    setLoading(true)
    setError(null)
    try {
      if (selectedBridge === 'layerzero') await executeLayerzero(amountWei)
      else if (selectedBridge === 'ccip') await executeCcip(amountWei)
      else if (selectedBridge === 'fastlane') await executeFastlane(amountWei)
      else await executeWormhole(amountWei)
      await fetchBalance()
      setAmount('')
    } catch (e: any) {
      setError(formatError(e))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, selectedBridge, account, sourceChainId, targetChainId, effectiveToken, bridgeAddress])

  const openConfirm = () => {
    if (!account || !sourceChainId || !targetChainId || !amount) {
      setError('请填写完整的跨链信息')
      return
    }
    if (!selectedBridge) {
      setError('请先点选一家桥：三家的费用、时效与安全模型不同，看清每张卡片再选')
      return
    }
    if (!bridgeAvailable(selectedBridge)) {
      // 快线给出专属拦截文案（测试网不可用 / 仅开通主网方向），不许含糊成「不可用」
      if (selectedBridge === 'fastlane' && sourceChain && targetChain) {
        const support = fastLanePairSupport(sourceChain.chainId, targetChain.chainId)
        if (!support.supported) {
          setError(fastLaneBlockMessage(support.reason))
          return
        }
      }
      setError('所选桥在当前源链/目标链组合下不可用，请换一家或换链')
      return
    }
    if (parseAmountToWei(amount) === 0n) {
      setError('请输入有效数量')
      return
    }
    if (selectedBridge === 'layerzero' && !effectiveToken) {
      setError('请填写代币地址')
      return
    }
    setError(null)
    setShowConfirm(true)
  }

  return (
    <div className="cross-chain-bridge">
      <h2>跨链桥</h2>
      <p className="hint">把代币从一条链转移到另一条链，到达后可在目标链继续交易。本站接了四条跨链通道：三家消息桥（LayerZero、Chainlink CCIP、Wormhole）和一条主网极速通道（做市商垫付）。费用、时效和安全模型各不相同，由你自己选，没有默认选项。怎么选：① 在意验证层厚实、费用先锁定 → 选 Chainlink CCIP；② 在意费用低、能接受等久一点和偶尔手动收尾 → 选 Wormhole；③ LayerZero 到账较快，但请先看清它卡片上标红的 1-of-1 验证方风险再决定；④ 赶时间、在主网之间转主流资产 → 选极速到账：做市商先在目的链垫付，几分钟到账，费用从到账里扣（仅主网，测试网不可用）。步骤：选源链与目标链 → 点选一条通道（先看每张卡上的实时报价、预计时效与风险说明）→ 填数量 → 点「发起跨链转移」后会再弹确认框复述费用与风险，确认后在钱包里依次批准即可。前提：已连接钱包，且钱包网络与所选源链一致，钱包里留有少量源链 ETH 付费用与 gas。</p>
      <p className="hint">关于 CCIP 与 Wormhole 的代币：这两家桥目前只支持 wTKA（TKA 的 1:1 包装代币）。发起时页面会自动把你的 TKA 按 1:1 换成 wTKA 再跨链（随时可 1:1 换回，不收差价）；目标链收到的是 wTKA，在目标链换回 TKA 后即可交易。LayerZero 通道直接转 TKA。</p>

      <ErrorDisplay error={error} onDismiss={() => setError(null)} className="bridge-error" />

      <div className="bridge-form">
        <div className="bridge-field">
          <label>源链</label>
          <select
            value={sourceChainId || ''}
            onChange={(e) => setSourceChainId(Number(e.target.value) || null)}
            disabled={loading}
          >
            <option value="">选择源链</option>
            {SUPPORTED_CHAINS.map((chain) => (
              <option key={chain.chainId} value={chain.chainId}>
                {chain.name}
              </option>
            ))}
          </select>
        </div>

        <div className="bridge-field">
          <label>目标链</label>
          <select
            value={targetChainId || ''}
            onChange={(e) => setTargetChainId(Number(e.target.value) || null)}
            disabled={loading}
          >
            <option value="">选择目标链</option>
            {SUPPORTED_CHAINS.filter((chain) => chain.chainId !== sourceChainId).map((chain) => (
              <option key={chain.chainId} value={chain.chainId}>
                {chain.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="bridge-selector">
        <label className="bridge-selector-title">选择桥（必选一项，点卡片选择）</label>
        <div className="bridge-cards">
          {BRIDGE_METAS.map((meta) => {
            const available = bridgeAvailable(meta.id)
            const isSelected = selectedBridge === meta.id
            const fastlaneSupport =
              meta.id === 'fastlane' && sourceChain && targetChain
                ? fastLanePairSupport(sourceChain.chainId, targetChain.chainId)
                : null
            const unavailableLabel =
              fastlaneSupport && !fastlaneSupport.supported && fastlaneSupport.reason === 'testnet'
                ? '主网功能 · 测试网不可用'
                : '当前链组合不可用'
            return (
              <div
                key={meta.id}
                className={`bridge-card${isSelected ? ' selected' : ''}${available ? '' : ' unavailable'}`}
                onClick={() => setSelectedBridge(meta.id)}
                role="radio"
                aria-checked={isSelected}
              >
                <div className="bridge-card-head">
                  <strong>{meta.name}</strong>
                  {isSelected && <span className="bridge-card-badge">已选</span>}
                  {!available && <span className="bridge-card-badge muted">{unavailableLabel}</span>}
                </div>
                <p>{quotes[meta.id] || meta.feeSummary}</p>
                <p>{meta.etaSummary}</p>
                <p className={meta.id === 'layerzero' ? 'bridge-risk-flag' : undefined}>{meta.securitySummary}</p>
                <details onClick={(e) => e.stopPropagation()}>
                  <summary>风险与细节说明</summary>
                  <ul>
                    {meta.riskPoints.map((r) => (
                      <li key={r.slice(0, 12)}>{r}</li>
                    ))}
                  </ul>
                </details>
              </div>
            )
          })}
        </div>
        {!selectedBridge && <p className="hint">尚未选择桥：请对比四张卡片的费用、时效与风险后点选一家，再继续。</p>}
      </div>

      <div className="bridge-form">
        {selectedBridge === 'ccip' || selectedBridge === 'wormhole' ? (
          <div className="bridge-field">
            <label>代币</label>
            <input type="text" value={sourceChain ? `TKA（${sourceChain.contracts.token0}，经 wTKA 1:1 转换）` : '请先选择源链'} disabled />
          </div>
        ) : (
          <div className="bridge-field">
            <label>代币地址</label>
            <input
              type="text"
              value={tokenAddress}
              onChange={(e) => setTokenAddress(e.target.value)}
              placeholder="0x..."
              disabled={loading}
            />
          </div>
        )}

        {selectedBridge === 'fastlane' && (
          <p className="hint">极速到账填法：代币地址留空 = 转源链原生币（如 ETH）；填 ERC20 地址时，USDC / WETH 会自动匹配目的链的同名资产，其他代币默认两链同地址。此通道仅主网可用（Ethereum ↔ Base），测试网不发起报价。</p>
        )}

        <div className="bridge-field">
          <label>数量</label>
          <div className="bridge-amount-row">
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.0"
              step="0.000001"
              disabled={loading}
            />
            {balance !== '0' && (
              <button type="button" className="btn-max" onClick={() => setAmount(balance)} disabled={loading}>
                最大
              </button>
            )}
          </div>
          {balance !== '0' && <p className="hint">可用余额：{balance}</p>}
          {selectedMeta && quotes[selectedMeta.id] && <p className="hint">{quotes[selectedMeta.id]}</p>}
        </div>

        {selectedBridge === 'layerzero' && (
          <div className="bridge-field">
            <label>跨链桥合约地址（可选）</label>
            <input
              type="text"
              value={customBridgeAddress}
              onChange={(e) => setCustomBridgeAddress(e.target.value)}
              placeholder="0x...（留空使用默认）"
              disabled={loading}
            />
          </div>
        )}

        <button
          className="btn primary"
          onClick={openConfirm}
          disabled={loading || !account || !sourceChainId || !targetChainId || !amount || !selectedBridge}
        >
          {loading ? '处理中…' : '发起跨链转移'}
        </button>
      </div>

      {bridgeStatus && (
        <div className="bridge-status">
          <p>{bridgeStatus}</p>
          {ccipMessageId && (
            <p>
              CCIP 消息 ID：<span className="mono">{ccipMessageId}</span>
              {' · '}
              <a href={`https://ccip.chain.link/msg/${ccipMessageId}`} target="_blank" rel="noreferrer">
                在 Chainlink CCIP 页面查状态
              </a>
            </p>
          )}
          {wormholeTxHash && (
            <p>
              Wormhole 发送交易：<span className="mono">{wormholeTxHash}</span>
              {' · '}
              <a
                href={`https://wormholescan.io/#/tx/${wormholeTxHash}?network=Testnet`}
                target="_blank"
                rel="noreferrer"
              >
                在 WormholeScan 查状态
              </a>
              （若长时间未到账，可在该页面获取消息证明 VAA 后按指引手动完成投递）
            </p>
          )}
          {fastlaneTxHash && (
            <p>
              极速到账发送交易：<span className="mono">{fastlaneTxHash}</span>
              {' · '}
              <a href="https://explorer.li.fi" target="_blank" rel="noreferrer">
                在 LI.FI Explorer 查状态
              </a>
              （本页也会自动刷新状态；若长时间未到账，不要重复发送，先查清原单状态）
            </p>
          )}
        </div>
      )}

      <p className="hint">注意：跨链转账不可撤销，发起后请勿重复提交同一笔转移。若长时间未到账，先凭发送交易哈希在对应桥的查询页确认状态：消息已发出但未投递时，按桥的机制等待或手动完成投递即可，不要重新再发一笔。</p>

      {sourceChain && targetChain && (
        <div className="bridge-info">
          <h3>本次转移</h3>
          <div className="info-row">
            <span>源链：</span>
            <span>{sourceChain.name}</span>
          </div>
          <div className="info-row">
            <span>目标链：</span>
            <span>{targetChain.name}</span>
          </div>
          <div className="info-row">
            <span>桥：</span>
            <span>{selectedMeta ? selectedMeta.name : '未选择'}</span>
          </div>
          <div className="info-row">
            <span>代币：</span>
            <span className="mono">{effectiveToken || '未设置'}</span>
          </div>
        </div>
      )}

      {showConfirm && selectedMeta && (
        <div className="bridge-confirm-overlay">
          <div className="bridge-confirm">
            <h3>确认跨链转移</h3>
            <p>
              你将通过 <strong>{selectedMeta.name}</strong> 把 {amount} 个代币从 {sourceChain?.name} 转到{' '}
              {targetChain?.name}。
            </p>
            <ul>
              <li>费用：{quotes[selectedMeta.id] || selectedMeta.feeSummary}</li>
              <li>时效：{selectedMeta.etaSummary}</li>
              <li>安全模型：{selectedMeta.securitySummary}</li>
              {selectedMeta.riskPoints.slice(0, 1).map((r) => (
                <li key={r.slice(0, 12)}>主要风险：{r}</li>
              ))}
              <li>跨链转账不可撤销；若消息已发出但长时间未投递，异常时可能需要人工完成投递，不要重复发送同一笔。</li>
              {(selectedBridge === 'ccip' || selectedBridge === 'wormhole') && (
                <li>本次会先把 TKA 按 1:1 换成 wTKA 再发送，目标链收到的是 wTKA，可 1:1 换回 TKA。</li>
              )}
              {selectedBridge === 'fastlane' && fastLaneQuote && (
                <>
                  <li>
                    预计到账：{formatUnits(fastLaneQuote.netReceived, fastLaneQuote.toTokenDecimals)}{' '}
                    {fastLaneQuote.toTokenSymbol}（最低 {formatUnits(fastLaneQuote.toAmountMin, fastLaneQuote.toTokenDecimals)}{' '}
                    {fastLaneQuote.toTokenSymbol}，低于最低值不会执行）
                  </li>
                  <li>
                    费用拆分：
                    {fastLaneQuote.deductedFees.length
                      ? fastLaneQuote.deductedFees
                          .map((f) => `${f.name} ${formatUnits(f.amount, f.decimals)} ${f.symbol}`)
                          .join('；')
                      : '无'}
                    （已包含在到账差额中、从到账扣除）；发送 gas{' '}
                    {fastLaneQuote.gasCosts.length
                      ? fastLaneQuote.gasCosts
                          .map((g) => `${formatUnits(g.amount, g.decimals)} ${g.symbol}`)
                          .join('；')
                      : '以钱包估算为准'}
                    （以源链原生币另行支付）
                  </li>
                  <li>履约方：{fastLaneQuote.routeTool}（由聚合器 LI.FI 在多家做市商/桥之间选路，以本次报价返回为准）；做市商在目的链先行垫付，你不用等源链最终确认。</li>
                  <li>回退路径：若无人接单或长时间未到账，不要重复发送；先在本页查状态，未履约可改走其余三家消息桥重新发起（先确认原单状态再发新单）。</li>
                </>
              )}
              {selectedBridge === 'fastlane' && !fastLaneQuote && (
                <li>发送前会重新获取一次实时报价；报价获取失败将中止发送，不会用旧报价执行。</li>
              )}
            </ul>
            <div className="bridge-confirm-actions">
              <button className="btn" onClick={() => setShowConfirm(false)} disabled={loading}>
                再想想
              </button>
              <button className="btn primary" onClick={handleConfirmExecute} disabled={loading}>
                {loading ? '处理中…' : '确认发起'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
