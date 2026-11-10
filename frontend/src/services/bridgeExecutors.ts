/**
 * 消息桥执行器（第四十一轮抽取）：LayerZero / Chainlink CCIP / Wormhole 三条消息桥的
 * 报价、可用性判定与执行，原本内嵌在桥页组件 CrossChainBridge 中，本轮抽成服务，
 * 桥页手动通道与「跨链默认桥」自动交付编排（services/defaultBridge）共用同一份实现，
 * 不许两处各写一套桥调用（项目底线：不重复造轮子）。
 *
 * 骑乘的既有件：第 9/16 轮 LayerZero CrossChainBridge 合约（bridgeToken/quoteBridgeFee）、
 * 第 19 轮 CCIP 官方 Router + WrappedTKA 胶水代币、Wormhole 官方 NTT Manager + 核心桥。
 * 极速到账（LI.FI）不在本文件：它在 services/fastLane.ts，且不进默认桥第一期。
 */
import { Contract, ZeroAddress, AbiCoder, zeroPadValue } from 'ethers'
import type { Provider, Signer } from 'ethers'
import type { ChainConfig } from '../config/chains'
import { ERC20_ABI, VAULT_ABI } from '../config'

export type MessageChannelId = 'layerzero' | 'ccip' | 'wormhole'

export const MESSAGE_CHANNELS: readonly MessageChannelId[] = ['layerzero', 'ccip', 'wormhole']

export const CROSS_CHAIN_BRIDGE_ABI = [
  'function bridgeToken(address token, uint256 amount, uint32 dstEid, bytes calldata options) payable returns (uint256 transferId, bytes32 guid)',
  'function quoteBridgeFee(address token, uint256 amount, uint32 dstEid, address user, bytes calldata options) view returns (uint256 nativeFee, uint256 lzTokenFee)',
  'function supportedTokens(address token) view returns (bool)',
  'function tokenMapping(uint32 dstEid, address token) view returns (address)',
  'function getBridgeStatus(bytes32 guid) view returns (uint8 status, uint256 transferId, uint256 initiatedAt, uint256 completedAt, uint256 attempts)',
  'function retryBridge(uint256 transferId, bytes calldata options) payable returns (bytes32 guid)',
  'event BridgeInitiated(bytes32 indexed guid, uint256 indexed transferId, address indexed user, address token, uint256 amount, uint32 dstEid)',
  'event BridgeStatusUpdated(uint256 indexed transferId, uint8 status, uint256 timestamp)',
] as const

// WrappedTKA：在 ERC20 之外只需 wrap（TKA -> wTKA，1:1）与 unwrap（烧 WTKA 换回 TKA，无需授权）
export const WRAPPED_TOKEN_ABI = [...ERC20_ABI, 'function wrap(uint256 amount)', 'function unwrap(uint256 amount)'] as const

// Chainlink CCIP 官方 Router（JSON ABI，含 tuple 结构）
export const CCIP_ROUTER_ABI = [
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
export const CCIP_EXTRA_ARGS_V3_BASIC = '0xa69dd4aa' + '00'.repeat(15)

// Wormhole 官方 NTT Manager 与核心桥
export const NTT_MANAGER_ABI = [
  'function transfer(uint256 amount, uint16 recipientChain, bytes32 recipient, bytes32 refundAddress, bool shouldQueue, bytes encodedInstructions) payable returns (uint64 msgId)',
] as const
export const WORMHOLE_CORE_ABI = ['function messageFee() view returns (uint256)'] as const
// NTT 单个 Wormhole Transceiver 的标准空指令编码（计数 1 + index 0 + 长度 0）
export const NTT_SINGLE_TRANSCEIVER_INSTRUCTIONS = '0x010000'

// LayerZero EID（Endpoint ID）映射
export const LAYERZERO_EIDS: Record<number, number> = {
  1: 30101, // Ethereum Mainnet
  8453: 30184, // Base Mainnet
  42161: 30110, // Arbitrum One
  137: 30109, // Polygon
  10: 30111, // Optimism
  11155111: 40161, // Sepolia
  84532: 40245, // Base Sepolia
  421614: 40231, // Arbitrum Sepolia
}

export interface BridgeRouteContext {
  account: string
  sourceChain: ChainConfig
  targetChain: ChainConfig
  /** LayerZero 桥合约地址（缺省取源链配置 contracts.crossChainBridge；桥页允许自定义覆盖） */
  bridgeAddress?: string
}

export function resolveBridgeAddress(sourceChain: ChainConfig, override?: string): string {
  if (override) return override
  const configured = sourceChain.contracts.crossChainBridge
  return configured && configured !== ZeroAddress ? configured : ''
}

/** 三条消息桥在给定链对下是否具备发起条件（与桥页 bridgeAvailable 的消息桥部分同口径） */
export function messageBridgeAvailable(channel: MessageChannelId, ctx: BridgeRouteContext): boolean {
  const { sourceChain, targetChain } = ctx
  if (channel === 'layerzero') {
    return Boolean(resolveBridgeAddress(sourceChain, ctx.bridgeAddress)) && Boolean(LAYERZERO_EIDS[targetChain.chainId])
  }
  if (channel === 'ccip') {
    return Boolean(sourceChain.ccip && targetChain.ccip && sourceChain.contracts.wrappedToken)
  }
  return Boolean(sourceChain.wormhole && targetChain.wormhole && sourceChain.contracts.wrappedToken)
}

/** CCIP 消息体（报价与发送共用，保证同一口径） */
export function buildCcipMessage(sourceChain: ChainConfig, account: string, amountWei: bigint) {
  return {
    receiver: AbiCoder.defaultAbiCoder().encode(['address'], [account]),
    data: '0x',
    tokenAmounts: [{ token: sourceChain.contracts.wrappedToken!, amount: amountWei }],
    extraArgs: CCIP_EXTRA_ARGS_V3_BASIC,
    feeToken: ZeroAddress,
  }
}

/**
 * 实时报价：返回发送时以源链原生币支付的费用（wei）。
 * LZ = quoteBridgeFee 的 nativeFee；CCIP = Router.getFee；Wormhole = 核心桥 messageFee。
 * 失败向上抛，由调用方决定文案（桥页显示「暂时获取失败」，编排器据此中止发起）。
 */
export async function quoteMessageBridgeFee(
  channel: MessageChannelId,
  ctx: BridgeRouteContext,
  provider: Provider,
  tokenAddress: string,
  amountWei: bigint
): Promise<bigint> {
  const { sourceChain, targetChain, account } = ctx
  if (channel === 'layerzero') {
    const bridge = new Contract(resolveBridgeAddress(sourceChain, ctx.bridgeAddress), CROSS_CHAIN_BRIDGE_ABI, provider)
    const [nativeFee] = await bridge.quoteBridgeFee(tokenAddress, amountWei, LAYERZERO_EIDS[targetChain.chainId], account, '0x')
    return nativeFee as bigint
  }
  if (channel === 'ccip') {
    const router = new Contract(sourceChain.ccip!.router, CCIP_ROUTER_ABI, provider)
    const fee: bigint = await router.getFee(BigInt(targetChain.ccip!.chainSelector), buildCcipMessage(sourceChain, account, amountWei))
    return fee
  }
  const core = new Contract(sourceChain.wormhole!.coreBridge, WORMHOLE_CORE_ABI, provider)
  return (await core.messageFee()) as bigint
}

/** 精确包裹指定数量 TKA → wTKA：授权（不足才批）→ wrap。桥页准备区与 CCIP/Wormhole 执行共用。 */
export async function wrapTkaExact(signer: Signer, sourceChain: ChainConfig, account: string, exactWei: bigint): Promise<void> {
  if (exactWei <= 0n) return
  const tkaAddress = sourceChain.contracts.token0
  const wtkaAddress = sourceChain.contracts.wrappedToken!
  const wtka = new Contract(wtkaAddress, WRAPPED_TOKEN_ABI, signer)
  const tka = new Contract(tkaAddress, ERC20_ABI, signer)
  const allowance: bigint = await tka.allowance(account, wtkaAddress)
  if (allowance < exactWei) {
    const tx = await tka.approve(wtkaAddress, exactWei)
    await tx.wait()
  }
  const wrapTx = await wtka.wrap(exactWei)
  await wrapTx.wait()
}

/** 补足 wTKA 差额（CCIP / Wormhole 发送前）：已有 wTKA 足够则不动。 */
export async function wrapTkaShortfall(signer: Signer, sourceChain: ChainConfig, account: string, amountWei: bigint): Promise<void> {
  const wtka = new Contract(sourceChain.contracts.wrappedToken!, WRAPPED_TOKEN_ABI, signer)
  const current: bigint = await wtka.balanceOf(account)
  if (current >= amountWei) return
  await wrapTkaExact(signer, sourceChain, account, amountWei - current)
}

export interface BridgeExecResult {
  channel: MessageChannelId
  /** 源链发送交易哈希 */
  txHash: string
  /** 通道追踪标识：LZ = guid，CCIP = messageId，Wormhole = 发送交易哈希 */
  trackingId: string
  /** 桥费（源链原生币 wei，发送时实付；Wormhole 为 messageFee） */
  nativeFeeWei: bigint
}

/**
 * 第 63 轮桥-2（P1-①）：广播瞬间回调钩子。发送交易一拿到 tx 对象（广播成功、
 * 尚未等回执）就回调，调用方据此**先落盘 hash 再等结果**——进程崩溃/断网后，
 * 恢复方凭落盘 hash 对账，而不是凭状态猜测是否已发送。
 */
export interface BridgeExecHooks {
  /** 桥发送交易广播成功后、等待回执前回调（参数 = 发送交易 hash） */
  onSendTxHash?: (hash: string) => void | Promise<void>
  /** CCIP 静态预取到 messageId 后、正式发送前回调（恢复 initiating 时用作追踪 ID） */
  onPrefetchTrackingId?: (trackingId: string) => void | Promise<void>
}

/**
 * 执行一条消息桥转移（钱包余额 → 目标链同地址）。
 * tokenAddress 仅 LayerZero 用（直转该代币）；CCIP / Wormhole 固定经 wTKA 1:1 转换（源链 TKA）。
 * 与桥页原执行逻辑逐行同构（授权不足才批、静态调用取 CCIP 消息 ID 等口径不变）。
 */
export async function executeMessageBridge(
  channel: MessageChannelId,
  ctx: BridgeRouteContext,
  signer: Signer,
  tokenAddress: string,
  amountWei: bigint,
  hooks?: BridgeExecHooks
): Promise<BridgeExecResult> {
  const { account, sourceChain, targetChain } = ctx
  if (channel === 'layerzero') {
    const bridgeAddress = resolveBridgeAddress(sourceChain, ctx.bridgeAddress)
    if (!bridgeAddress) throw new Error('跨链桥合约地址未配置')
    const token = new Contract(tokenAddress, ERC20_ABI, signer)
    const allowance: bigint = await token.allowance(account, bridgeAddress)
    if (allowance < amountWei) {
      const approveTx = await token.approve(bridgeAddress, amountWei)
      await approveTx.wait()
    }
    const bridge = new Contract(bridgeAddress, CROSS_CHAIN_BRIDGE_ABI, signer)
    const dstEid = LAYERZERO_EIDS[targetChain.chainId]
    if (!dstEid) throw new Error(`目标链 ${targetChain.chainId} 暂不支持跨链（无 LayerZero EID 配置）`)
    const [nativeFee] = await bridge.quoteBridgeFee(tokenAddress, amountWei, dstEid, account, '0x')
    const tx = await bridge.bridgeToken(tokenAddress, amountWei, dstEid, '0x', { value: nativeFee })
    await hooks?.onSendTxHash?.(tx.hash)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error('跨链交易未成功')
    let guid = ''
    const initiated = receipt.logs.find((log: any) => {
      try {
        return bridge.interface.parseLog(log)?.name === 'BridgeInitiated'
      } catch {
        return false
      }
    })
    if (initiated) {
      const parsed = bridge.interface.parseLog(initiated)
      guid = parsed?.args[0] ?? ''
    }
    return { channel, txHash: receipt.hash, trackingId: guid, nativeFeeWei: nativeFee as bigint }
  }

  if (channel === 'ccip') {
    await wrapTkaShortfall(signer, sourceChain, account, amountWei)
    const wtkaAddress = sourceChain.contracts.wrappedToken!
    const router = new Contract(sourceChain.ccip!.router, CCIP_ROUTER_ABI, signer)
    const wtka = new Contract(wtkaAddress, ERC20_ABI, signer)
    const allowance: bigint = await wtka.allowance(account, sourceChain.ccip!.router)
    if (allowance < amountWei) {
      const tx = await wtka.approve(sourceChain.ccip!.router, amountWei)
      await tx.wait()
    }
    const message = buildCcipMessage(sourceChain, account, amountWei)
    const selector = BigInt(targetChain.ccip!.chainSelector)
    const fee: bigint = await router.getFee(selector, message)
    // 先用静态调用取消息 ID（与真实发送同一状态下计算，结果一致），再正式发送
    const messageId: string = await router.ccipSend.staticCall(selector, message, { value: fee })
    await hooks?.onPrefetchTrackingId?.(messageId)
    const tx = await router.ccipSend(selector, message, { value: fee })
    await hooks?.onSendTxHash?.(tx.hash)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error('跨链交易未成功')
    return { channel, txHash: receipt.hash, trackingId: messageId, nativeFeeWei: fee }
  }

  // wormhole
  await wrapTkaShortfall(signer, sourceChain, account, amountWei)
  const wtkaAddress = sourceChain.contracts.wrappedToken!
  const manager = new Contract(sourceChain.wormhole!.nttManager, NTT_MANAGER_ABI, signer)
  const wtka = new Contract(wtkaAddress, ERC20_ABI, signer)
  const allowance: bigint = await wtka.allowance(account, sourceChain.wormhole!.nttManager)
  if (allowance < amountWei) {
    const tx = await wtka.approve(sourceChain.wormhole!.nttManager, amountWei)
    await tx.wait()
  }
  const core = new Contract(sourceChain.wormhole!.coreBridge, WORMHOLE_CORE_ABI, signer)
  const fee: bigint = await core.messageFee()
  const recipient = zeroPadValue(account, 32)
  const tx = await manager.transfer(
    amountWei,
    targetChain.wormhole!.wormholeChainId,
    recipient,
    recipient,
    false,
    NTT_SINGLE_TRANSCEIVER_INSTRUCTIONS,
    { value: fee }
  )
  await hooks?.onSendTxHash?.(tx.hash)
  const receipt = await tx.wait()
  if (!receipt || receipt.status !== 1) throw new Error('跨链交易未成功')
  return { channel, txHash: receipt.hash, trackingId: receipt.hash, nativeFeeWei: fee }
}

/** 从成交链 Vault 提出余额到钱包（交付发起的第一步；VAULT_ABI 与资产页同源）。
 * onTxHash：第 63 轮桥-2——广播瞬间（等回执前）回调，调用方先落盘提款 hash。 */
export async function withdrawFromVault(
  signer: Signer,
  chain: ChainConfig,
  token: string,
  amountWei: bigint,
  onTxHash?: (hash: string) => void | Promise<void>
): Promise<string> {
  const vault = new Contract(chain.contracts.vault, VAULT_ABI, signer)
  const tx = await vault.withdraw(token, amountWei)
  await onTxHash?.(tx.hash)
  const receipt = await tx.wait()
  if (!receipt || receipt.status !== 1) throw new Error('从 Vault 提取成交款失败')
  return receipt.hash as string
}

/** 交易回执事实（第 63 轮桥-2 对账原语）：无回执 = pending（不等于不存在） */
export async function checkTxReceipt(
  provider: Provider,
  hash: string
): Promise<'success' | 'reverted' | 'pending'> {
  try {
    const receipt = await provider.getTransactionReceipt(hash)
    if (!receipt) return 'pending'
    return receipt.status === 1 ? 'success' : 'reverted'
  } catch {
    return 'pending'
  }
}

/** 节点是否还认识这笔交易（已广播未打包时为 true；被丢弃/从未广播为 false） */
export async function txKnownToNode(provider: Provider, hash: string): Promise<boolean> {
  try {
    return (await provider.getTransaction(hash)) != null
  } catch {
    return false
  }
}

/**
 * 从发送交易回执解析 LayerZero BridgeInitiated 的 guid（第 63 轮桥-2：恢复卡住的
 * initiating 记录时重建追踪信息用）。解析不出返回 null，调用方降级用 txHash 追踪。
 */
export async function fetchLayerZeroGuidByTxHash(
  provider: Provider,
  sourceChain: ChainConfig,
  txHash: string,
  bridgeAddressOverride?: string
): Promise<string | null> {
  try {
    const receipt = await provider.getTransactionReceipt(txHash)
    if (!receipt || receipt.status !== 1) return null
    const bridge = new Contract(resolveBridgeAddress(sourceChain, bridgeAddressOverride), CROSS_CHAIN_BRIDGE_ABI, provider)
    for (const log of receipt.logs) {
      try {
        const parsed = bridge.interface.parseLog(log)
        if (parsed?.name === 'BridgeInitiated') return parsed.args[0] as string
      } catch {
        // 非本合约日志，跳过
      }
    }
    return null
  } catch {
    return null
  }
}

/** 通道追踪链接（§4.2 交付记录字段） */
export function bridgeTrackingUrl(channel: MessageChannelId, trackingId: string, testnet: boolean): string {
  if (channel === 'ccip') return `https://ccip.chain.link/msg/${trackingId}`
  if (channel === 'wormhole') return `https://wormholescan.io/#/tx/${trackingId}?network=${testnet ? 'Testnet' : 'Mainnet'}`
  return `https://layerzeroscan.com/tx/${trackingId}`
}

/** LayerZero 在途状态读取（桥合约 getBridgeStatus；status: 0 待处理 / 1 处理中 / 2 已完成 / 3 失败） */
export async function fetchLayerZeroStatus(
  provider: Provider,
  sourceChain: ChainConfig,
  guid: string,
  bridgeAddressOverride?: string
): Promise<{ status: number; attempts: number } | null> {
  if (!guid) return null
  try {
    const bridge = new Contract(resolveBridgeAddress(sourceChain, bridgeAddressOverride), CROSS_CHAIN_BRIDGE_ABI, provider)
    const [status, , , , attempts] = await bridge.getBridgeStatus(guid)
    return { status: Number(status), attempts: Number(attempts) }
  } catch {
    return null
  }
}
