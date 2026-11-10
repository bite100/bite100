/**
 * 跨链默认桥 · 交付编排器（第四十一轮，第一期）
 *
 * 设计 §1.2 / §7.1：交付发起与结算绑定为同一编排流程——结算确认后，编排器为每笔
 * 成交的每个收款方判定交付并生成交付记录；记录以（成交 ID × 收款方）幂等，
 * 重扫/重启凭键去重，永不重复发起。结算失败或未成交 → 永不生成待交付记录。
 *
 * 第一期的执行现实（与 §2.1 载体定版一致）：编排器运行在前端，只为**当前连接的
 * 用户本人**执行交付（提款与桥存入都要本人钱包签名）；发起动作收敛为交付记录上的
 * 一次点击（executeDelivery），因为 Vault 没有委托提款接口、钱包也不允许无签名
 * 代扣。无点击的纯自动发起须等 Vault 链上 opt-in/委托的合约轮（第二期候选）。
 * 对手方的交付由对手方自己的客户端以同一套代码编排，记录互不可见（本地存储）。
 */
import { Contract } from 'ethers'
import type { Provider, Signer } from 'ethers'
import { getChainConfig } from '../../config/chains'
import { getPairTokens } from '../../config/pairs'
import { VAULT_ABI } from '../../config'
import { formatError, getProvider, withSigner } from '../../utils'
import {
  bridgeTrackingUrl,
  executeMessageBridge,
  fetchLayerZeroStatus,
  withdrawFromVault,
} from '../bridgeExecutors'
import { getDisclosure, isTestnetChain } from './disclosures'
import {
  deliveryKey,
  getDelivery,
  loadDeliveries,
  saveDeliveries,
  transition,
  upsertDelivery,
} from './deliveries'
import { consumeTempOverride } from './settings'
import { channelSupports, decideRoute, hasValidConfirmation } from './support'
import type { DeliveryRecord, DefaultBridgeSettings } from './types'

/** 一笔已结算成交的交付判定输入（节点/索引器的成交行都带齐这些字段） */
export interface SettledFillInput {
  tradeId: string
  settleChainId: number
  maker: string
  taker: string
  tokenIn: string
  tokenOut: string
  /** 1e18 定点整数字符串（与节点/索引器口径一致） */
  amountIn: string
  amountOut: string
  /** 交易对（可选，仅展示用；本地 Trade 适配时带入） */
  pair?: string
}

export interface Receipt {
  receiver: string
  asset: string
  amountWei: bigint
}

/** 代币地址 → 符号（按链配置 tokens 登记反查；未登记返回 null） */
export function symbolForToken(chainId: number, tokenAddress: string): string | null {
  const cfg = getChainConfig(chainId)
  if (!cfg?.tokens) return null
  const target = tokenAddress.toLowerCase()
  for (const [sym, addr] of Object.entries(cfg.tokens)) {
    if (addr.toLowerCase() === target) return sym
  }
  return null
}

/**
 * 一笔成交的两个收款方向（结算记账口径）：maker 收到 tokenOut × amountOut，
 * taker 收到 tokenIn × amountIn。资产符号无法识别的一侧跳过（不凭空编造）。
 */
export function computeReceipts(fill: SettledFillInput): Receipt[] {
  const out: Receipt[] = []
  const makerAsset = symbolForToken(fill.settleChainId, fill.tokenOut)
  if (makerAsset) out.push({ receiver: fill.maker, asset: makerAsset, amountWei: safeBig(fill.amountOut) })
  const takerAsset = symbolForToken(fill.settleChainId, fill.tokenIn)
  if (takerAsset) out.push({ receiver: fill.taker, asset: takerAsset, amountWei: safeBig(fill.amountIn) })
  return out
}

function safeBig(v: string): bigint {
  try {
    return BigInt(v)
  } catch {
    return 0n
  }
}

/** 本地 p2p Trade（带 makerSide）→ SettledFillInput 的适配（金额/价格均为 1e18 定点字符串） */
export function fillFromLocalTrade(
  trade: {
    tradeId: string
    maker: string
    taker: string
    pair: string
    amount: string
    price: string
    makerSide?: 'buy' | 'sell'
  },
  settleChainId: number
): SettledFillInput | null {
  if (!trade.makerSide) return null
  const tokens = getPairTokens(settleChainId, trade.pair)
  if (!tokens) return null
  const amount = safeBig(trade.amount)
  const price = safeBig(trade.price)
  const quoteAmount = (amount * price) / 10n ** 18n
  if (trade.makerSide === 'sell') {
    // maker 卖基础币：付出 base(amount)，收到 quote(amount×price)
    return {
      tradeId: trade.tradeId,
      settleChainId,
      maker: trade.maker,
      taker: trade.taker,
      pair: trade.pair,
      tokenIn: tokens.base,
      tokenOut: tokens.quote,
      amountIn: amount.toString(),
      amountOut: quoteAmount.toString(),
    }
  }
  // maker 买基础币：付出 quote(amount×price)，收到 base(amount)
  return {
    tradeId: trade.tradeId,
    settleChainId,
    maker: trade.maker,
    taker: trade.taker,
    pair: trade.pair,
    tokenIn: tokens.quote,
    tokenOut: tokens.base,
    amountIn: quoteAmount.toString(),
    amountOut: amount.toString(),
  }
}

export interface PlanOutcome {
  record: DeliveryRecord | null
  created: boolean
}

/**
 * 为「当前用户作为收款方」的一笔已结算成交生成交付记录（幂等：已有记录原样返回）。
 * 用户未介入过默认桥设置（无默认通道/无主场链）时不生成任何记录、不做任何动作
 * （验收 §10.2：未设置默认桥的用户跨链成交后款留成交链 Vault、无任何自动动作）。
 */
export function planDelivery(
  account: string,
  fill: SettledFillInput,
  settings: DefaultBridgeSettings,
  now: number = Date.now()
): PlanOutcome {
  const mine = computeReceipts(fill).find((r) => r.receiver.toLowerCase() === account.toLowerCase())
  if (!mine) return { record: null, created: false }
  const existing = getDelivery(account, fill.tradeId, account)
  if (existing) return { record: existing, created: false }
  if (!settings.defaultChannel || !settings.homeChainId) return { record: null, created: false }

  const base: DeliveryRecord = {
    id: deliveryKey(fill.tradeId, account),
    tradeId: fill.tradeId,
    receiver: account,
    settleChainId: fill.settleChainId,
    homeChainId: settings.homeChainId,
    pair: fill.pair ?? '',
    asset: mine.asset,
    amountWei: mine.amountWei.toString(),
    channel: null,
    executor: 'bridge',
    status: 'not-needed',
    fundsLocation: 'vault',
    createdAt: now,
    updatedAt: now,
  }

  // §6 三级的一次性临时授权：用户在下单时已当场选过临时通道 → 直接按它规划
  const override = consumeTempOverride(account, fill.settleChainId, mine.asset)
  if (override?.channel === 'settle-chain-only') {
    base.status = 'not-needed'
    const { created } = upsertDelivery(account, base)
    return { record: base, created }
  }
  if (override && channelSupports(override.channel, fill.settleChainId, settings.homeChainId, mine.asset)) {
    base.channel = override.channel
    base.status = hasValidConfirmation(settings, override.channel) ? 'pending-decision' : 'suspended-disclosure'
    const { created } = upsertDelivery(account, base)
    return { record: base, created }
  }

  const decision = decideRoute(settings, fill.settleChainId, mine.asset)
  switch (decision.kind) {
    case 'default':
      base.channel = decision.channel
      base.status = 'pending-decision'
      break
    case 'suspended-disclosure':
      base.channel = decision.channel
      base.status = 'suspended-disclosure'
      break
    case 'ask':
      base.status = 'ask-required'
      break
    case 'none':
      base.status = 'not-needed'
      break
  }
  const { created } = upsertDelivery(account, base)
  return { record: base, created }
}

function persist(account: string, record: DeliveryRecord): void {
  const records = loadDeliveries(account)
  const idx = records.findIndex((r) => r.id === record.id)
  if (idx >= 0) records[idx] = record
  else records.push(record)
  saveDeliveries(account, records)
}

export interface ExecuteDeps {
  withSignerFn?: typeof withSigner
  provider?: Provider | null
}

/**
 * 加载时批量复验（第 63 轮桥-1）：对全部 pending-decision 记录按当前披露版本
 * 复验确认有效性，失效的立即迁移回 suspended-disclosure 并落盘——让升版挂起
 * 在用户点「发起交付」之前就如实呈现。执行时复验（executeDelivery 内）保留作
 * 最终防线，双层同口径（骑既有 hasValidConfirmation）。
 * 返回复验后的全部记录（未变更时不写盘）。
 */
export function revalidatePendingDisclosures(
  account: string,
  settings: DefaultBridgeSettings,
  now: number = Date.now()
): DeliveryRecord[] {
  const records = loadDeliveries(account)
  let changed = false
  const next = records.map((r) => {
    if (r.status === 'pending-decision' && r.channel && !hasValidConfirmation(settings, r.channel)) {
      changed = true
      return transition(r, { type: 'disclosure-invalidated', at: now })
    }
    return r
  })
  if (changed) saveDeliveries(account, next)
  return next
}

/**
 * 发起一笔交付（记录须为 pending-decision 且已定通道）：
 * Vault 提款（资金在钱包时跳过）→ 桥存入，全程骑 bridgeExecutors 的既有实现。
 * 桥费由收款方承担（§5 定版）：桥存入的原生币费用由收款方钱包支付——正是本人签名
 * 支付；结算 gas 的对半分摊已在结算时按第 21 轮规则扣过，与此处无关、两笔账分开。
 *
 * 第 63 轮桥-1（P1-②）：发起前先按**当前** settings 复验披露确认——披露升版后
 * 升版前生成的 pending-decision 记录不得按旧披露执行；失效即迁移回挂起并中止。
 */
export async function executeDelivery(
  account: string,
  recordId: string,
  settings: DefaultBridgeSettings,
  deps: ExecuteDeps = {}
): Promise<DeliveryRecord> {
  const withSignerFn = deps.withSignerFn ?? withSigner
  const provider = deps.provider ?? getProvider()
  let record = loadDeliveries(account).find((r) => r.id === recordId)
  if (!record) throw new Error('交付记录不存在')
  if (!record.channel) throw new Error('交付记录尚未选定通道')
  const channel = record.channel
  if (record.status === 'pending-decision' && !hasValidConfirmation(settings, channel)) {
    record = transition(record, { type: 'disclosure-invalidated', at: Date.now() })
    persist(account, record)
    throw new Error('披露已更新，请重新确认后继续')
  }
  const settleChain = getChainConfig(record.settleChainId)
  const homeChain = getChainConfig(record.homeChainId)
  if (!settleChain || !homeChain) throw new Error('链配置缺失，无法发起交付')

  record = transition(record, { type: 'initiate', at: Date.now() })
  persist(account, record)

  let stage: 'withdraw' | 'bridge' = record.fundsLocation === 'wallet' ? 'bridge' : 'withdraw'
  try {
    const result = await withSignerFn(async (signer: Signer) => {
      let amount = safeBig(record!.amountWei)
      if (stage === 'withdraw') {
        // 以 Vault 实际可用余额为准：结算时 gas 对半扣减后，可用额可能略低于成交额
        if (provider) {
          const vault = new Contract(settleChain.contracts.vault, VAULT_ABI, provider)
          const token = settleChain.tokens?.[record!.asset]
          if (!token) throw new Error(`成交链未登记资产 ${record!.asset}`)
          const available: bigint = await vault.availableBalance(token, account)
          if (available <= 0n) throw new Error('成交链 Vault 可用余额为 0，无法发起交付')
          if (available < amount) amount = available
        }
        const token = settleChain.tokens?.[record!.asset]
        if (!token) throw new Error(`成交链未登记资产 ${record!.asset}`)
        await withdrawFromVault(signer, settleChain, token, amount)
        stage = 'bridge'
      }
      const tokenAddress = settleChain.tokens?.[record!.asset] ?? ''
      return {
        amount,
        res: await executeMessageBridge(
          channel,
          { account, sourceChain: settleChain, targetChain: homeChain },
          signer,
          tokenAddress,
          amount
        ),
      }
    })
    record = transition(record, {
      type: 'initiated',
      at: Date.now(),
      txHash: result.res.txHash,
      trackingId: result.res.trackingId,
      trackingUrl: bridgeTrackingUrl(channel, result.res.trackingId, isTestnetChain(record.settleChainId)),
      feeNativeWei: result.res.nativeFeeWei.toString(),
    })
    record = { ...record, amountWei: result.amount.toString(), fundsLocation: undefined }
    persist(account, record)
    return record
  } catch (e) {
    const note =
      stage === 'bridge' && record.fundsLocation !== 'wallet'
        ? `成交款已从 Vault 提到你的钱包（未离开成交链），桥存入未成功：${formatError(e)}。可重试交付（将从钱包余额发起）或自行处理。`
        : `交付发起失败，成交款仍在成交链 Vault：${formatError(e)}`
    record = transition(record, { type: 'initiation-failed', at: Date.now(), note })
    record = { ...record, fundsLocation: stage === 'bridge' ? 'wallet' : 'vault' }
    persist(account, record)
    return record
  }
}

/**
 * 刷新一笔在途交付的状态：LayerZero 走链上 getBridgeStatus；CCIP / Wormhole
 * 第一期只做超时判定（状态追踪走交付记录里的追踪链接，§7.2 三件套之状态追踪）。
 * 超时 → 异常（超时），绝不置 fallbackCredited（防双记账，§7.3）。
 */
export async function refreshDelivery(
  account: string,
  recordId: string,
  provider: Provider | null,
  now: number = Date.now()
): Promise<DeliveryRecord> {
  let record = loadDeliveries(account).find((r) => r.id === recordId)
  if (!record) throw new Error('交付记录不存在')
  if (record.status !== 'in-flight') return record
  const disclosure = getDisclosure(record.channel!)
  const timeoutMs = isTestnetChain(record.settleChainId) ? disclosure.timeoutMs.testnet : disclosure.timeoutMs.mainnet

  if (record.channel === 'layerzero' && provider && record.trackingId) {
    const settleChain = getChainConfig(record.settleChainId)
    if (settleChain) {
      const st = await fetchLayerZeroStatus(provider, settleChain, record.trackingId)
      if (st?.status === 2) {
        record = transition(record, { type: 'delivered', at: now })
        persist(account, record)
        return record
      }
      if (st?.status === 3) {
        record = transition(record, {
          type: 'channel-failure-confirmed',
          at: now,
          // 如实口径（第 63 轮 P2）：第一期没有平台记回机制，旧文案「将退回 Vault」
          // 是不存在的承诺，已删。资金确切位置 = 桥侧失败状态，用户实际路径 = 桥的
          // 重试投递 / 人工中继入口，追踪链接就在本记录里。
          note: 'LayerZero 桥合约状态为失败。款项停留在桥侧失败状态，未到账主场链，也不会自动退回成交链 Vault（平台没有自动记回机制）。请凭下方追踪链接到 LayerZero Scan 核对状态，并通过桥的重试投递或无许可 lzReceive 人工中继处理；确认最终结果前请勿重复发起同一笔交付。',
        })
        persist(account, record)
        return record
      }
    }
  }

  if (record.initiatedAt && now - record.initiatedAt > timeoutMs) {
    record = transition(record, {
      type: 'timeout',
      at: now,
      note: disclosure.failureGuide.inTransitTimeout,
    })
    persist(account, record)
    return record
  }
  return record
}
