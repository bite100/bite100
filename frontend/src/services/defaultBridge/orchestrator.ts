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
  checkTxReceipt,
  executeMessageBridge,
  fetchLayerZeroGuidByTxHash,
  fetchLayerZeroStatus,
  txKnownToNode,
  withdrawFromVault,
} from '../bridgeExecutors'
import type { ChainConfig } from '../../config/chains'
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
import { RegistryConflictError, defaultRegistry } from './registry'
import type { DeliveryRegistry, ReportInput } from './registry'
import type { DeliveryRecord, DefaultBridgeSettings } from './types'

/** 交付汇报 best-effort：记账失败绝不影响已发生的链上动作（桥-3 口径） */
async function reportBestEffort(registry: DeliveryRegistry, input: ReportInput): Promise<void> {
  try {
    await registry.report(input)
  } catch {
    // 中继汇报失败只丢记账，本地记录与链上对账（桥-2）仍可恢复真相
  }
}

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
  /** 第 63 轮桥-2：执行器注入点（默认真实实现；测试用桩验证 hash 落盘时序） */
  executeBridgeFn?: typeof executeMessageBridge
  withdrawFn?: typeof withdrawFromVault
  /** 第 63 轮桥-3：交付登记（默认中继 HTTP 登记；claim 是闸门，report 是记账） */
  registry?: DeliveryRegistry
}

/** 第 63 轮桥-2 对账依赖（原语可注入，默认骑 bridgeExecutors 的链上读取） */
export interface ReconcileDeps {
  provider?: Provider | null
  now?: number
  checkReceiptFn?: (provider: Provider, hash: string) => Promise<'success' | 'reverted' | 'pending'>
  txKnownFn?: (provider: Provider, hash: string) => Promise<boolean>
  fetchGuidFn?: (provider: Provider, chain: ChainConfig, txHash: string) => Promise<string | null>
  /** 第 63 轮桥-3：对账结论同步汇报中继登记（best-effort） */
  registry?: DeliveryRegistry
}

/**
 * 发送交易「节点不认识 + 发起已超过此时长」才可由对账判定 missing（第 63 轮桥-2）。
 * 取 1 小时：远大于常规打包时间，又远小于交付超时口径；判定错了（交易其实还在
 * 别的节点内存池）会导致双投递风险，故同时要求节点不认识该 hash 才成立。
 */
const RECONCILE_MISSING_AFTER_MS = 60 * 60 * 1000

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
  const executeBridgeFn = deps.executeBridgeFn ?? executeMessageBridge
  const withdrawFn = deps.withdrawFn ?? withdrawFromVault
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

  // 第 63 轮桥-2（P1-①）：先落意图凭证再执行——attemptId/序号 + pending 标记在任何
  // 链上动作之前落盘；之后每次广播的 hash 都经钩子即时落盘。这样进程在任意点
  // 崩溃，恢复方都有凭证对账，而不是只剩一个无出口的 initiating 状态。
  // attemptId 带随机后缀：同浏览器多标签页各自算出的序号相同，后缀保证凭证
  // 唯一——第二个标签页的 claim 会被中继判冲突，而不是被当作同一次重试放行。
  const attemptNo = (record.attemptCount ?? 0) + 1
  const attemptId = `${record.id}#${attemptNo}.${Math.random().toString(36).slice(2, 8)}`

  // 第 63 轮桥-3（P1-③）：发起前先向中继 claim 占位（跨设备仲裁）。claim 是
  // 闸门：冲突/不可达一律中止发起（fail-closed），本地记录保持 pending 不动。
  // 首次冲突时以 supersede 申请接管一次——中继侧只对陈旧占位放行，新鲜占位
  //（另一设备正在执行）仍会拒绝，错误如实抛给用户。
  const registry = deps.registry ?? defaultRegistry
  const claimInput = { deliveryId: record.id, account, attemptId, channel }
  try {
    await registry.claim(claimInput)
  } catch (e) {
    if (e instanceof RegistryConflictError) {
      await registry.claim({ ...claimInput, supersede: true })
    } else {
      throw e
    }
  }

  record = transition(record, { type: 'initiate', at: Date.now() })
  record = {
    ...record,
    attemptCount: attemptNo,
    attemptId,
    initiatedTxPending: true,
    sendTxHash: undefined,
    withdrawTxHash: undefined,
    prefetchTrackingId: undefined,
  }
  persist(account, record)

  // 本次发起是否发生过任何广播（第一方事实，供失败时判定可否直接记 missing）
  let withdrawBroadcast = false
  let sendBroadcast = false
  const hooks = {
    onSendTxHash: async (hash: string) => {
      sendBroadcast = true
      record = { ...record, sendTxHash: hash, updatedAt: Date.now() }
      persist(account, record)
    },
    onPrefetchTrackingId: async (id: string) => {
      record = { ...record, prefetchTrackingId: id, updatedAt: Date.now() }
      persist(account, record)
    },
  }

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
        await withdrawFn(signer, settleChain, token, amount, async (hash: string) => {
          withdrawBroadcast = true
          record = { ...record, withdrawTxHash: hash, updatedAt: Date.now() }
          persist(account, record)
        })
        stage = 'bridge'
      }
      const tokenAddress = settleChain.tokens?.[record!.asset] ?? ''
      return {
        amount,
        res: await executeBridgeFn(
          channel,
          { account, sourceChain: settleChain, targetChain: homeChain },
          signer,
          tokenAddress,
          amount,
          hooks
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
    record = { ...record, amountWei: result.amount.toString(), fundsLocation: undefined, initiatedTxPending: false }
    persist(account, record)
    // 桥-3 记账：向中继汇报已发起（best-effort，失败不影响已发生的交付）
    await reportBestEffort(registry, {
      deliveryId: record.id,
      account,
      attemptId,
      state: 'initiated',
      sendTxHash: result.res.txHash,
      trackingId: result.res.trackingId,
    })
    return record
  } catch (e) {
    const note =
      stage === 'bridge' && record.fundsLocation !== 'wallet'
        ? `成交款已从 Vault 提到你的钱包（未离开成交链），桥存入未成功：${formatError(e)}。可重试交付（将从钱包余额发起）或自行处理。`
        : `交付发起失败，成交款仍在成交链 Vault：${formatError(e)}`
    record = transition(record, { type: 'initiation-failed', at: Date.now(), note })
    record = { ...record, fundsLocation: stage === 'bridge' ? 'wallet' : 'vault' }
    // 第 63 轮桥-2 对账口径：
    // - 桥发送已广播（sendBroadcast）：结果未知——保留 pending 标记且不下 missing
    //   结论，重试必须先过对账（reconcileDelivery / retryDelivery）。
    // - 未发生桥发送广播（拒签/报价失败/提款失败，或提款已广播但桥发送未广播）：
    //   桥发起确定未上链是第一方事实，直接记 missing 并清 pending，重试可放行。
    if (sendBroadcast) {
      record = { ...record, initiatedTxPending: true }
    } else {
      record = { ...record, initiatedTxPending: false, lastReconcile: 'missing', lastReconcileAt: Date.now() }
    }
    persist(account, record)
    // 桥-3 记账：汇报本次尝试异常终局，释放中继占位（best-effort）。注意
    // sendBroadcast 的情形桥发送可能已上链——汇报 anomaly 只释放「认领」，
    // 不改变桥-2 的对账口径：本地恢复仍以链上回执为准，found 时会再汇报
    // initiated 覆盖（中继状态机允许 anomaly ← initiated 的修正汇报）。
    await reportBestEffort(registry, {
      deliveryId: record.id,
      account,
      attemptId,
      state: 'anomaly',
      note: record.anomalyNote,
    })
    return record
  }
}

/**
 * 对账（第 63 轮桥-2，P1-①）：对卡住的 initiating 记录与「已广播但结果未落定」的
 * anomaly 记录，按既有链上事实面判定上一笔发起的真实结果：
 * - 发送回执 success → found：重建追踪信息（LZ 解析 guid / CCIP 用预取 messageId /
 *   Wormhole 用 txHash），记录恢复为 in-flight，**不重发**；
 * - 发送回执 reverted，或提款已终局而桥发送从未广播，或发送交易节点不认识且发起
 *   已超 RECONCILE_MISSING_AFTER_MS → missing：initiating 转发起失败，pending 清除，
 *   此后才允许重试；
 * - 其余 → unknown：只盖章，不动状态，重试继续被状态机拒绝。
 * 无 provider 时只能盖 unknown 章。第 62 轮前的老 anomaly 记录（无 attemptId、
 * 无任何 hash）：旧流程是全程等待回执后才落异常，其失败是本会话内已观察的事实，
 * 直接记 missing 放行重试；老 initiating 记录无 hash 可查，保持 unknown 待人工处理。
 */
export async function reconcileDelivery(
  account: string,
  recordId: string,
  deps: ReconcileDeps = {}
): Promise<DeliveryRecord> {
  const now = deps.now ?? Date.now()
  let record = loadDeliveries(account).find((r) => r.id === recordId)
  if (!record) throw new Error('交付记录不存在')
  const active =
    record.status === 'initiating' || (record.status === 'anomaly' && record.initiatedTxPending === true)
  if (!active) {
    // 第 63 轮前老记录的兼容判定（见函数头注）
    if (
      record.status === 'anomaly' &&
      record.anomalyKind === 'initiation-failed' &&
      record.attemptId === undefined &&
      !record.sendTxHash &&
      !record.withdrawTxHash &&
      record.lastReconcile === undefined
    ) {
      record = { ...record, lastReconcile: 'missing', lastReconcileAt: now, updatedAt: now }
      persist(account, record)
    }
    return record
  }
  const provider = deps.provider ?? getProvider()
  if (!provider) {
    record = { ...record, lastReconcile: 'unknown', lastReconcileAt: now, updatedAt: now }
    persist(account, record)
    return record
  }
  const checkReceiptFn = deps.checkReceiptFn ?? checkTxReceipt
  const txKnownFn = deps.txKnownFn ?? txKnownToNode
  const age = now - (record.initiatedAt ?? record.updatedAt)
  let verdict: 'found' | 'missing' | 'unknown' = 'unknown'
  if (record.sendTxHash) {
    const r = await checkReceiptFn(provider, record.sendTxHash)
    if (r === 'success') verdict = 'found'
    else if (r === 'reverted') verdict = 'missing'
    else if (!(await txKnownFn(provider, record.sendTxHash)) && age > RECONCILE_MISSING_AFTER_MS) verdict = 'missing'
  } else if (record.withdrawTxHash) {
    const r = await checkReceiptFn(provider, record.withdrawTxHash)
    // 提款已终局（成功=钱在钱包 / 失败=钱在 Vault）而桥发送从未广播 → 桥发起确定 missing
    if (r === 'success' || r === 'reverted') verdict = 'missing'
    else if (!(await txKnownFn(provider, record.withdrawTxHash)) && age > RECONCILE_MISSING_AFTER_MS) verdict = 'missing'
  }
  // 无任何 hash（崩溃在广播与钩子之间）：无法断言，保持 unknown 待人工处理。
  record = { ...record, lastReconcile: verdict, lastReconcileAt: now, updatedAt: now }
  const registry = deps.registry ?? defaultRegistry
  if (verdict === 'found' && record.sendTxHash && record.channel) {
    let trackingId = record.prefetchTrackingId ?? ''
    if (record.channel === 'wormhole') trackingId = record.sendTxHash
    if (record.channel === 'layerzero') {
      const fetchGuidFn = deps.fetchGuidFn ?? fetchLayerZeroGuidByTxHash
      const settleChain = getChainConfig(record.settleChainId)
      trackingId =
        (settleChain ? await fetchGuidFn(provider, settleChain, record.sendTxHash) : null) ?? record.sendTxHash
    }
    if (!trackingId) trackingId = record.sendTxHash
    record = transition(record, {
      type: 'initiated',
      at: now,
      txHash: record.sendTxHash,
      trackingId,
      trackingUrl: bridgeTrackingUrl(record.channel, trackingId, isTestnetChain(record.settleChainId)),
      feeNativeWei: record.feeNativeWei ?? '0',
    })
    record = { ...record, initiatedTxPending: false, lastReconcile: 'found', lastReconcileAt: now }
    persist(account, record)
    // 桥-3 记账：对账恢复同步汇报中继（best-effort）
    if (record.attemptId) {
      await reportBestEffort(registry, {
        deliveryId: record.id,
        account,
        attemptId: record.attemptId,
        state: 'initiated',
        sendTxHash: record.txHash,
        trackingId: record.trackingId,
      })
    }
    return record
  } else if (verdict === 'missing' && record.status === 'initiating') {
    record = transition(record, {
      type: 'initiation-failed',
      at: now,
      note: '对账确认上一笔发起未上链（missing）：未发现发送交易上链事实，可安全重试。',
    })
    record = { ...record, initiatedTxPending: false, lastReconcile: 'missing', lastReconcileAt: now }
    persist(account, record)
    if (record.attemptId) {
      await reportBestEffort(registry, {
        deliveryId: record.id,
        account,
        attemptId: record.attemptId,
        state: 'anomaly',
        note: 'reconcile: missing',
      })
    }
    return record
  }
  persist(account, record)
  return record
}

/**
 * 安全重试（第 63 轮桥-2）：重试前强制对账——记录在 initiating 或带 pending 标记的
 * anomaly 先 reconcileDelivery；已恢复为 in-flight 的直接返回（不重发）；对账非
 * missing 一律抛错拒绝；判定 missing 后才走状态机 retry（状态机再验一次 missing）
 * 并重新执行。组件「重试交付」按钮统一走这里。
 */
export async function retryDelivery(
  account: string,
  recordId: string,
  settings: DefaultBridgeSettings,
  deps: ExecuteDeps & ReconcileDeps = {}
): Promise<DeliveryRecord> {
  let record = loadDeliveries(account).find((r) => r.id === recordId)
  if (!record) throw new Error('交付记录不存在')
  if (record.status === 'initiating' || record.status === 'anomaly') {
    record = await reconcileDelivery(account, recordId, deps)
    if (record.status === 'in-flight' || record.status === 'delivered') return record
    if (record.status === 'initiating') {
      throw new Error('上一笔发起对账未定（unknown），为避免重复投递暂不能重试；请稍后再试')
    }
    if (record.status === 'anomaly') {
      if (record.anomalyKind !== 'initiation-failed') {
        throw new Error('只有发起失败的交付可以重试；在途异常请先走追踪与人工中继兜底')
      }
      if (record.lastReconcile !== 'missing') {
        throw new Error('上一笔发起结果未确认（对账未判定 missing），为避免重复投递暂不能重试；请稍后刷新对账')
      }
      record = transition(record, { type: 'retry', at: Date.now() })
      persist(account, record)
    }
  }
  return executeDelivery(account, recordId, settings, deps)
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
