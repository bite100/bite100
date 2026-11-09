/**
 * 无节点阶段 4（停节点总验收）运行器引擎。
 *
 * 形态：纯无节点路径——签名订单只投公告栏中继（relay），撮合调生产
 * 模块 services/matching 的 executeFrontendMatch 无头运行（内部即
 * 双读→matcher→prune→settleTradesBatch 自提），节点只作为「已停机
 * 的对照源」被注入双读（其 fetch 失败被双读记为 errors.node，
 * 正是阶段 4 要验证的降级行为：单源失效不拖垮整轮、中继单源经
 * 本地验签 + 链上状态过滤后形成可成交集）。
 *
 * 骑乘关系（不重复造轮子，详见 README 对照表）：订单生成/签名/预检
 * 骑 soak 的 generator；撮合结算骑生产 executeFrontendMatch；索引器
 * 探针骑 tradesDual 的 fetchIndexerTrades；回执解析骑 SETTLEMENT_ABI；
 * 链上已成交量读数用最小 ABI 片段（与 generator 既有最小 ABI 模式
 * 同构）。自有代码只有：中继单发、场景轮转、探针编排、记账。
 *
 * 零容忍线（任一触发立即停跑、保全证据、状态文件标 triggered）：
 * 订单丢失（中继已接单却始终不出现在中继簿）、无效成交上链
 * （回执失败/成交事件与预期腿数不符/已成交量超签名量）、篡改单
 * 被中继接受、索引器成交与链上回执不一致（宽限期后仍缺失或
 * 金额多重集不符）。
 *
 * 密钥纪律：只从 S4_KEYS_DIR（默认 ~/workspace/bite100-deployer）
 * 的 maker.env / taker.env / wallet.env 运行时读取，绝不打印/落盘。
 * 仅测试网链（11155111 / 84532），其他 chainId 直接拒绝。
 */
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ethers } from 'ethers'
import { createPublicClient, http } from 'viem'
import { getChainConfig, type ChainConfig } from '../../src/config/chains'
import { DEFAULT_PAIR, TRADE_PAIRS, getPairTokens } from '../../src/config/pairs'
import {
  generateBatch,
  loadWallets,
  vaultAvailable,
  TESTNET_CHAINS,
  type GeneratedOrder,
  type OrderSpec,
  type SoakWallet,
} from '../soak/generator'
import {
  buildSignedOrderData,
  computeOrderDigest,
} from '../../src/services/dualread/digest'
import {
  createRelayBookAdapter,
  normalizeBookRows,
  requireBookSides,
  sortBookSide,
  type BookAdapter,
} from '../../src/services/dualread/adapters'
import {
  createChainStateReader,
  createViemChainTransport,
  type ChainStateReader,
} from '../../src/services/dualread/chainState'
import type { RawOrder, SourceBook } from '../../src/services/dualread/types'
import { runDualReadRound } from '../../src/services/dualread/index'
import { executeFrontendMatch } from '../../src/services/matching/execute'
import { orderDataToContractOrder } from '../../src/services/matching/fills'
import type { OrderData } from '../../src/services/orderSigningTypes'
import { SETTLEMENT_ABI } from '../../src/services/settlementAbi'
import { VAULT_LOCK_ABI } from '../../src/services/vaultAbi'
import { fetchIndexerTrades, type IndexerTrade } from '../../src/services/tradesDual'

// ---------------------------------------------------------------- 配置

export interface Stage4Config {
  keysDir: string
  relayUrl: string
  indexerUrl: string
  outDir: string
  intervalSec: number
  maxHours: number
  targetPerChain: number
  submitGapMs: number
  indexerGraceSec: number
  nodeUrls: Record<number, string>
}

export function loadConfig(): Stage4Config {
  const home = homedir()
  return {
    keysDir:
      process.env.S4_KEYS_DIR ?? join(home, 'workspace', 'bite100-deployer'),
    relayUrl: (
      process.env.S4_RELAY_URL ?? 'https://bit100-relay.q3874758.workers.dev'
    ).replace(/\/$/, ''),
    indexerUrl: (process.env.S4_INDEXER_URL ?? '').replace(/\/$/, ''),
    outDir: process.env.S4_DIR ?? join(home, 'workspace', 'bite100-stage4'),
    intervalSec: Number(process.env.S4_INTERVAL_SEC ?? 180),
    maxHours: Number(process.env.S4_MAX_HOURS ?? 17),
    targetPerChain: Number(process.env.S4_TARGET_PER_CHAIN ?? 150),
    submitGapMs: Number(process.env.S4_SUBMIT_GAP_MS ?? 1500),
    indexerGraceSec: Number(process.env.S4_INDEXER_GRACE_SEC ?? 900),
    nodeUrls: {
      11155111: process.env.S4_NODE_URL_11155111 ?? 'http://127.0.0.1:8080',
      84532: process.env.S4_NODE_URL_84532 ?? 'http://127.0.0.1:8081',
    },
  }
}

export const CHAINS = [11155111, 84532] as const
const PRICE = '2000' // 合成定价（与 soak 同口径：测状态机保真，不测价格真实性）

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 超时硬化（2026-11-09 方案 B，Ren 批准）：给一段异步工作套硬超时，
 * 超时以 CycleTimeoutError 抛出，由主循环按 cycle-error 记账并继续，
 * 不再让某个无超时的网络等待整夜冻结运行器。被放弃的原 promise 迟到
 * 拒绝会被吞掉（防 unhandled rejection 崩溃）；其迟到副作用（迟到的
 * 成交仍受合约签名限价与累计记账约束，合法性不受影响）由账本与
 * Envio 对账在汇总时兜底。
 */
export class CycleTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} 超时（>${Math.round(ms / 1000)}s，超时硬化）`)
    this.name = 'CycleTimeoutError'
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new CycleTimeoutError(label, ms)), ms)
  })
  p.catch(() => {})
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

const CHAIN_CYCLE_TIMEOUT_MS = 420_000
const RECHECK_TIMEOUT_MS = 240_000
const lc = (s: string) => (s ?? '').toLowerCase()
export const log = (msg: string) =>
  console.log(`[stage4 ${new Date().toISOString()}] ${msg}`)

// ------------------------------------------------------- 最小 ABI 片段
// （与 soak/generator 的最小 ABI 模式同构：产品 ABI 子集未覆盖的
// 只读/归责入口在此声明，不改产品 ABI 文件）

const SETTLE_READ_ABI = [
  'function orderFilledIn(bytes32 digest) view returns (uint256)',
  'function orderFilledOut(bytes32 digest) view returns (uint256)',
] as const

// 注：orderLocks 已在 VAULT_LOCK_ABI 内（execute.ts 同骑），此处只补释放入口
const VAULT_EXTRA_ABI = [
  'function releaseOrderLock(bytes32 digest)',
  'function releaseExpiredOrderLock(bytes32 digest)',
] as const

const CHARGE_FAILED_ABI = [
  {
    type: 'function',
    name: 'chargeFailedSettlement',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'signedOrder',
        type: 'tuple',
        components: [
          {
            name: 'order',
            type: 'tuple',
            components: [
              { name: 'orderId', type: 'string' },
              { name: 'userAddress', type: 'address' },
              { name: 'tokenIn', type: 'address' },
              { name: 'tokenOut', type: 'address' },
              { name: 'amountIn', type: 'uint256' },
              { name: 'amountOut', type: 'uint256' },
              { name: 'price', type: 'uint256' },
              { name: 'timestamp', type: 'uint256' },
              { name: 'expiresAt', type: 'uint256' },
              { name: 'nonce', type: 'uint256' },
              { name: 'side', type: 'uint8' },
            ],
          },
          { name: 'signature', type: 'bytes' },
        ],
      },
      { name: 'reason', type: 'uint8' },
      { name: 'gasUsedClaimed', type: 'uint256' },
    ],
    outputs: [],
  },
] as const

const FAIL_ORDER_EXPIRED = 1

// ---------------------------------------------------------------- 记账

export interface PostedOrder {
  digest: string
  orderId: string
  chainId: number
  pair: string
  role: string
  side: string
  relayOk: boolean
  relayStatus: number | null
  tampered: boolean
  amountIn: string
  expiresAt: number
  postedAt: number
}

export interface SettlementRecord {
  txHash: string
  chainId: number
  pair: string
  takerDigest: string
  legs: number
  settledAt: number
  events: Array<{ maker: string; taker: string; amountIn: string; amountOut: string }>
  probe: {
    receipt: 'pending' | 'ok' | 'fail'
    eventsMatch: 'pending' | 'ok' | 'fail'
    indexer: 'pending' | 'ok' | 'mismatch'
    indexerCheckedAt?: number
  }
}

export interface FailureItem {
  ts: number
  chainId: number
  kind: string
  detail: string
  digest?: string
  txHash?: string
}

export interface ChainCounts {
  posted: number
  relayAccepted: number
  matchSubmitted: number
  matchNoMatch: number
  matchAborted: number
  settlements: number
  legs: number
  scenarios: Record<string, number>
}

export class ZeroToleranceError extends Error {}

/** 构建备注：2026-11-08 例行复审修复 B1/B3/B2-lite（工作树未提交版，随后续修复轮提交） */
export const BUILD_NOTE = '运行器含 2026-11-08 复审修复 B1/B3/B2-lite（工作树未提交版）+ 2026-11-09 超时硬化（方案 B，Ren 批准）：单链周期 420s 硬超时、探针复查 240s 硬超时、中继发单 30s/节点拉簿 10s 请求超时；超时按 cycle-error 记账并继续，不再整夜卡死'

export class Stage4Ledger {
  posted = new Map<string, PostedOrder>()
  settlements: SettlementRecord[] = []
  failures: FailureItem[] = []
  counts: Record<number, ChainCounts> = {}
  zero = {
    orderLost: 0,
    invalidSettle: 0,
    tamperAccepted: 0,
    indexerMismatch: 0,
    triggered: false,
    detail: '',
  }
  cycles = 0

  constructor(
    private readonly metricsPath: string,
    private readonly statePath: string,
    readonly windowStart: number,
    readonly windowEndPlanned: number,
  ) {
    for (const c of CHAINS) {
      this.counts[c] = {
        posted: 0,
        relayAccepted: 0,
        matchSubmitted: 0,
        matchNoMatch: 0,
        matchAborted: 0,
        settlements: 0,
        legs: 0,
        scenarios: {},
      }
    }
  }

  line(obj: Record<string, unknown>): void {
    appendFileSync(this.metricsPath, JSON.stringify(obj) + '\n')
  }

  fail(item: FailureItem): void {
    this.failures.push(item)
    this.line({ ...item, kind: 'failure', failureKind: item.kind })
    log(`FAIL [${item.kind}] chain ${item.chainId}: ${item.detail}`)
  }

  /** 零容忍触发：落盘 + 状态文件 + 抛错停跑（不掩盖、不重跑洗掉） */
  trip(kind: keyof Omit<typeof this.zero, 'triggered' | 'detail'>, detail: string, ctx: Partial<FailureItem> = {}): never {
    this.zero[kind] += 1
    this.zero.triggered = true
    this.zero.detail = detail
    const item: FailureItem = {
      ts: Date.now(),
      chainId: ctx.chainId ?? 0,
      kind: `zerotolerance:${kind}`,
      detail,
      digest: ctx.digest,
      txHash: ctx.txHash,
    }
    this.failures.push(item)
    this.line({ ...item, kind: 'zerotolerance', failureKind: item.kind })
    this.saveState('zero-tolerance-triggered')
    throw new ZeroToleranceError(`${kind}: ${detail}`)
  }

  saveState(status: string): void {
    const state = {
      windowStart: this.windowStart,
      windowEndPlanned: this.windowEndPlanned,
      updatedAt: Date.now(),
      status,
      note: BUILD_NOTE,
      cycles: this.cycles,
      chains: this.counts,
      zeroTolerance: this.zero,
      failures: this.failures.slice(-50),
      settlementsTail: this.settlements.slice(-20).map((s) => ({
        txHash: s.txHash,
        chainId: s.chainId,
        pair: s.pair,
        legs: s.legs,
        probe: s.probe,
      })),
    }
    const tmp = `${this.statePath}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2))
    renameSync(tmp, this.statePath)
  }
}

// ------------------------------------------------------------- 链上下文

export interface ChainCtx {
  chainId: number
  chainCfg: ChainConfig
  provider: ethers.JsonRpcProvider
  viem: ReturnType<typeof createPublicClient>
  maker: SoakWallet
  taker: SoakWallet
  deployer: SoakWallet
  makerSigner: ethers.NonceManager
  takerSigner: ethers.NonceManager
  deployerSigner: ethers.NonceManager
  settlementRead: ethers.Contract
  vaultRead: ethers.Contract
  nonceCursor: Map<string, number>
  nodeAdapter: BookAdapter
  relayAdapter: BookAdapter
  chainReader: ChainStateReader
}

/** 生成器产出的 body 即 RawOrder 形状（同一份订单原文），此处做一次显式收口 */
const asRaw = (gen: GeneratedOrder): RawOrder => gen.body as unknown as RawOrder

/** 从 env 文件提取私钥（与 generator.extractKey 同规则；generator 未导出） */
function extractKey(filePath: string): string {
  const text = readFileSync(filePath, 'utf8')
  const m = text.match(/0x[0-9a-fA-F]{64}/)
  if (!m) throw new Error(`密钥文件缺少私钥令牌: ${filePath.split('/').pop()}`)
  return m[0]
}

function loadDeployer(keysDir: string): SoakWallet {
  const wallet = new ethers.Wallet(extractKey(join(keysDir, 'wallet.env')))
  return { role: 'maker', wallet, address: wallet.address }
}

/** 节点适配器：与 soak/runner 的 createDirectNodeAdapter 同实现（节点停机时 fetch 失败，双读按源错误降级） */
function createDirectNodeAdapter(nodeUrl: string): BookAdapter {
  return {
    async fetchBook(chainId: number, pair: string) {
      const res = await fetch(
        `${nodeUrl}/api/orderbook?pair=${encodeURIComponent(pair)}`,
        { signal: AbortSignal.timeout(10_000) },
      )
      if (!res.ok) throw new Error(`node orderbook http ${res.status}`)
      const data: unknown = await res.json()
      const { bids: rawBids, asks: rawAsks } = requireBookSides(data, 'node')
      const nb = normalizeBookRows(rawBids)
      const na = normalizeBookRows(rawAsks)
      return {
        source: 'node' as const,
        chainId,
        pair,
        bids: sortBookSide(nb.orders, 'buy'),
        asks: sortBookSide(na.orders, 'sell'),
        complete: true,
        fetchedAt: Date.now(),
        rawRows: rawBids.length + rawAsks.length,
        droppedRows: nb.droppedRows + na.droppedRows,
      }
    },
  }
}

export function buildChainCtx(
  cfg: Stage4Config,
  chainId: number,
  wallets: SoakWallet[],
  deployer: SoakWallet,
): ChainCtx {
  if (!(TESTNET_CHAINS as readonly number[]).includes(chainId)) {
    throw new Error(`stage4 只允许测试网链，拒绝 chainId=${chainId}`)
  }
  const chainCfg = getChainConfig(chainId)
  if (!chainCfg) throw new Error(`unknown chain ${chainId}`)
  const byRole = new Map(wallets.map((w) => [w.role, w]))
  const maker = byRole.get('maker')!
  const taker = byRole.get('taker')!
  const provider = new ethers.JsonRpcProvider(chainCfg.rpcUrl)
  const signerOf = (w: SoakWallet) =>
    new ethers.NonceManager(w.wallet.connect(provider))
  return {
    chainId,
    chainCfg,
    provider,
    viem: createPublicClient({ transport: http(chainCfg.rpcUrl) }),
    maker,
    taker,
    deployer,
    makerSigner: signerOf(maker),
    takerSigner: signerOf(taker),
    deployerSigner: signerOf(deployer),
    settlementRead: new ethers.Contract(
      chainCfg.contracts.settlement,
      [...SETTLEMENT_ABI, ...SETTLE_READ_ABI] as unknown as ethers.InterfaceAbi,
      provider,
    ),
    vaultRead: new ethers.Contract(
      chainCfg.contracts.vault,
      [...VAULT_LOCK_ABI, ...VAULT_EXTRA_ABI] as unknown as ethers.InterfaceAbi,
      provider,
    ),
    nonceCursor: new Map(),
    nodeAdapter: createDirectNodeAdapter(cfg.nodeUrls[chainId]),
    relayAdapter: createRelayBookAdapter(cfg.relayUrl),
    chainReader: createChainStateReader(createViemChainTransport()),
  }
}

// ------------------------------------------------------------- 中继单发

export interface RelayPostResult {
  ok: boolean
  status: number | null
  error?: string
}

/** 只投中继（阶段 4 的唯一投递路径；形状与 generator.submitOrder 的中继半边一致） */
export async function postToRelay(
  relayUrl: string,
  gen: GeneratedOrder,
  sideOverride?: 'buy' | 'sell',
): Promise<RelayPostResult> {
  const body = {
    ...gen.body,
    chainId: gen.chainId,
    ...(sideOverride ? { side: sideOverride } : {}),
  }
  try {
    const res = await fetch(`${relayUrl}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `http ${res.status}: ${(await res.text()).slice(0, 160)}`,
      }
    }
    return { ok: true, status: res.status }
  } catch (e) {
    return { ok: false, status: null, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 生成一单并投中继、记账；返回生成结果（被预检跳过时 gen 为 null） */
async function genAndPost(
  ledger: Stage4Ledger,
  ctx: ChainCtx,
  relayUrl: string,
  spec: OrderSpec,
  opts: { tamper?: boolean } = {},
): Promise<{ gen: GeneratedOrder | null; skipReason?: string }> {
  const { generated, skipped } = await generateBatch(
    ctx.chainId,
    [ctx.maker, ctx.taker],
    [spec],
    ctx.nonceCursor,
  )
  if (generated.length === 0) {
    return { gen: null, skipReason: skipped[0]?.reason ?? '生成被跳过（无原因）' }
  }
  const gen = generated[0]
  const data = buildSignedOrderData(asRaw(gen), ctx.chainId)
  const tamperSide = opts.tamper
    ? gen.side === 'buy'
      ? ('sell' as const)
      : ('buy' as const)
    : undefined
  const res = await postToRelay(relayUrl, gen, tamperSide)
  const rec: PostedOrder = {
    digest: gen.digest.toLowerCase(),
    orderId: String(gen.body.orderId),
    chainId: ctx.chainId,
    pair: spec.pair,
    role: spec.role,
    side: spec.side,
    relayOk: res.ok,
    relayStatus: res.status,
    tampered: Boolean(opts.tamper),
    amountIn: data ? data.amountIn : '0',
    expiresAt: Number(gen.body.expiresAt ?? 0),
    postedAt: Date.now(),
  }
  ledger.posted.set(rec.digest, rec)
  ledger.counts[ctx.chainId].posted += 1
  if (res.ok && !opts.tamper) ledger.counts[ctx.chainId].relayAccepted += 1
  ledger.line({ kind: 'posted', ...rec, relayError: res.error })
  if (opts.tamper) {
    // 篡改单被中继接受 = 零容忍（阶段 3 后 side 在签名内，改写副本
    // 验签必失败，中继应在入库处拒绝）
    if (res.ok) {
      ledger.trip('tamperAccepted', `篡改单被中继接受（digest=${rec.digest}）`, {
        chainId: ctx.chainId,
        digest: rec.digest,
      })
    }
    log(`chain ${ctx.chainId} 篡改注入被中继拒绝（status=${res.status}），符合预期`)
  } else if (!res.ok) {
    ledger.fail({
      ts: Date.now(),
      chainId: ctx.chainId,
      kind: 'relay-post-failed',
      detail: `订单投递中继失败 status=${res.status}: ${res.error ?? ''}`,
      digest: rec.digest,
    })
  }
  return { gen }
}

/** 在场探针：中继已接单的订单必须出现在中继簿里（按 orderId 查），否则按订单丢失计 */
async function probePresence(
  ledger: Stage4Ledger,
  ctx: ChainCtx,
  pair: string,
  gens: GeneratedOrder[],
): Promise<void> {
  const want = gens.filter((g) => {
    const rec = ledger.posted.get(g.digest.toLowerCase())
    return rec && rec.relayOk && !rec.tampered
  })
  if (want.length === 0) return
  const deadline = Date.now() + 60_000
  let missing = want
  while (Date.now() < deadline && missing.length > 0) {
    let book: SourceBook
    try {
      book = await ctx.relayAdapter.fetchBook(ctx.chainId, pair)
    } catch (e) {
      // B3 修复（2026-11-08 复审）：读簿异常原先直接冒泡成普通
      // cycle-error，探针无结论且不留痕。改为记一行 probe-inconclusive
      // 后本轮直接返回——不 trip orderLost、也不把这批单记为已验
      // 在簿；后续周期的在场探针/撮合读簿会自然重新覆盖。
      const reason = e instanceof Error ? e.message : String(e)
      ledger.line({
        kind: 'probe-inconclusive',
        ts: Date.now(),
        chainId: ctx.chainId,
        pair,
        reason,
        orders: want.length,
      })
      log(`chain ${ctx.chainId} 在场探针读簿异常（无结论）：${reason}`)
      return
    }
    const ids = new Set([...book.bids, ...book.asks].map((o) => o.orderId))
    missing = want.filter((g) => !ids.has(String(g.body.orderId)))
    if (missing.length > 0) await sleep(10_000)
  }
  for (const g of missing) {
    ledger.trip(
      'orderLost',
      `中继已接单但 60s 后仍不在中继簿：orderId=${String(g.body.orderId)} digest=${g.digest}`,
      { chainId: ctx.chainId, digest: g.digest },
    )
  }
}

// ------------------------------------------------------------- 撮合尝试

export interface MatchAttemptResult {
  status: 'submitted' | 'no-match' | 'aborted'
  txHash?: string
  legsKept: number
  legsPruned: number
  message: string
}

/**
 * 一次无头撮合：taker 订单先投中继（与线上前端「先广播后撮合」
 * 同序），再调生产 executeFrontendMatch（自带新鲜双读 + 预检剔腿
 * + 批结算自提）。no-match 时隔 10s 重试一次（中继读后写延迟的
 * 合理窗口），仍无对手才记 no-match。
 */
async function attemptMatch(
  ledger: Stage4Ledger,
  cfg: Stage4Config,
  ctx: ChainCtx,
  takerSpec: OrderSpec,
): Promise<{ result: MatchAttemptResult | null; takerGen: GeneratedOrder | null }> {
  const { gen, skipReason } = await genAndPost(ledger, ctx, cfg.relayUrl, takerSpec)
  if (!gen) {
    log(`chain ${ctx.chainId} taker 单生成跳过：${skipReason}`)
    return { result: null, takerGen: null }
  }
  const data = buildSignedOrderData(asRaw(gen), ctx.chainId)
  if (!data) {
    ledger.fail({
      ts: Date.now(),
      chainId: ctx.chainId,
      kind: 'taker-rebuild-failed',
      detail: `taker 订单签名重构失败 digest=${gen.digest}`,
      digest: gen.digest,
    })
    return { result: null, takerGen: gen }
  }
  let last: MatchAttemptResult | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(10_000)
    const outcome = await executeFrontendMatch(
      {
        chainId: ctx.chainId,
        pair: takerSpec.pair,
        takerData: data,
        takerSignature: String(gen.body.signature),
        signer: ctx.takerSigner,
      },
      {
        nodeAdapter: ctx.nodeAdapter,
        relayAdapter: ctx.relayAdapter,
        chainReader: ctx.chainReader,
      },
    )
    last = {
      status: outcome.status,
      txHash: outcome.txHash,
      legsKept: outcome.legsKept,
      legsPruned: outcome.legsPruned,
      message: outcome.message,
    }
    if (outcome.status !== 'no-match') break
  }
  const counts = ledger.counts[ctx.chainId]
  if (last!.status === 'submitted') {
    counts.matchSubmitted += 1
    counts.settlements += 1
    counts.legs += last!.legsKept
  } else if (last!.status === 'no-match') {
    counts.matchNoMatch += 1
  } else {
    counts.matchAborted += 1
  }
  ledger.line({
    kind: 'match',
    ts: Date.now(),
    chainId: ctx.chainId,
    pair: takerSpec.pair,
    takerDigest: gen.digest.toLowerCase(),
    ...last,
  })
  log(
    `chain ${ctx.chainId} 撮合 ${takerSpec.pair} taker/${takerSpec.side}: ${last!.status}` +
      (last!.txHash ? ` tx=${last!.txHash}` : '') +
      (last!.status !== 'submitted' ? `（${last!.message.slice(0, 80)}）` : ''),
  )
  return { result: last, takerGen: gen }
}

// ------------------------------------------------------------- 结算探针

const settleIface = new ethers.Interface(SETTLEMENT_ABI as unknown as ethers.InterfaceAbi)

interface ParsedTradeEvent {
  maker: string
  taker: string
  amountIn: string
  amountOut: string
}

function parseTradeEvents(
  receipt: ethers.TransactionReceipt,
  settlementAddress: string,
): ParsedTradeEvent[] {
  const out: ParsedTradeEvent[] = []
  for (const lg of receipt.logs) {
    // B2-lite 修复（2026-11-08 复审）：解析前先核对日志来源必须是
    // 本链 Settlement 合约（大小写不敏感），其他合约的同名事件跳过，
    // 避免混入非本合约日志污染成交事件计数/多重集。
    if (lc(lg.address) !== lc(settlementAddress)) continue
    try {
      const parsed = settleIface.parseLog({
        topics: [...lg.topics],
        data: lg.data,
      })
      if (parsed && (parsed.name === 'TradeSettled' || parsed.name === 'TradeSettledWithGasReimburse')) {
        out.push({
          maker: String(parsed.args.maker),
          taker: String(parsed.args.taker),
          amountIn: BigInt(parsed.args.amountIn).toString(),
          amountOut: BigInt(parsed.args.amountOut).toString(),
        })
      }
    } catch {
      // 非 Settlement 事件，忽略
    }
  }
  return out
}

const indexerFetchFn = async (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => {
  const res = await fetch(url, init)
  return { ok: res.ok, status: res.status, json: () => res.json() as Promise<unknown> }
}

function tradeMultisetKey(t: { maker: string; taker: string; amountIn: string; amountOut: string }): string {
  const norm = (v: string) => {
    try {
      return BigInt(v).toString()
    } catch {
      return v
    }
  }
  return `${lc(t.maker)}|${lc(t.taker)}|${norm(t.amountIn)}|${norm(t.amountOut)}`
}

/** 结算落账后立即跑回执探针 + 登记 settlement（索引器探针异步在后续周期复查） */
async function probeSettlement(
  ledger: Stage4Ledger,
  cfg: Stage4Config,
  ctx: ChainCtx,
  pair: string,
  attempt: MatchAttemptResult,
  takerGen: GeneratedOrder,
): Promise<void> {
  const txHash = attempt.txHash!
  const receipt = await ctx.provider.getTransactionReceipt(txHash)
  const rec: SettlementRecord = {
    txHash,
    chainId: ctx.chainId,
    pair,
    takerDigest: takerGen.digest.toLowerCase(),
    legs: attempt.legsKept,
    settledAt: Date.now(),
    events: [],
    probe: { receipt: 'pending', eventsMatch: 'pending', indexer: 'pending' },
  }
  ledger.settlements.push(rec)
  if (!receipt) {
    rec.probe.receipt = 'fail'
    ledger.trip('invalidSettle', `结算 tx 无回执：${txHash}`, { chainId: ctx.chainId, txHash })
  }
  if (receipt!.status !== 1) {
    rec.probe.receipt = 'fail'
    ledger.trip('invalidSettle', `结算 tx 回执 status=${receipt!.status}：${txHash}`, {
      chainId: ctx.chainId,
      txHash,
    })
  }
  rec.probe.receipt = 'ok'
  rec.events = parseTradeEvents(receipt!, ctx.chainCfg.contracts.settlement)
  if (rec.events.length !== attempt.legsKept) {
    rec.probe.eventsMatch = 'fail'
    ledger.trip(
      'invalidSettle',
      `成交事件数 ${rec.events.length} != 撮合腿数 ${attempt.legsKept}：${txHash}`,
      { chainId: ctx.chainId, txHash },
    )
  }
  rec.probe.eventsMatch = 'ok'
  // taker 已成交量不得超签名量（合约累计记账之外的第二道独立核对）
  const filledIn = (await ctx.settlementRead.orderFilledIn(
    takerGen.digest,
  )) as bigint
  const takerData = buildSignedOrderData(asRaw(takerGen), ctx.chainId)
  if (takerData && filledIn > BigInt(takerData.amountIn)) {
    ledger.trip(
      'invalidSettle',
      `taker 已成交量 ${filledIn} 超签名量 ${takerData.amountIn}：digest=${takerGen.digest}`,
      { chainId: ctx.chainId, txHash, digest: takerGen.digest },
    )
  }
  ledger.line({ kind: 'probe', ts: Date.now(), ...rec })
}

/** 索引器探针复查：pending 的 settlement 在宽限期内反复查，超时仍不符即零容忍 */
async function recheckIndexerProbes(
  ledger: Stage4Ledger,
  cfg: Stage4Config,
  ctxs: Map<number, ChainCtx>,
): Promise<void> {
  if (!cfg.indexerUrl) return
  for (const rec of ledger.settlements) {
    if (rec.probe.indexer !== 'pending') continue
    // B1 修复（2026-11-08 复审）：原先固定只读同交易对最近 50 条，
    // 同对新成交多了会把待核验的早期成交挤出窗口、900s 后误触发
    // indexerMismatch 假停机。改为按 offset 分页（每页 50、最多 10
    // 页、短页即止），全部页里按 txHash 找本笔；任一页查询失败则
    // 整笔按原口径稍后重试，不拿残缺窗口下结论。
    let rows: IndexerTrade[] = []
    try {
      for (let page = 0; page < 10; page++) {
        const chunk = await fetchIndexerTrades(
          rec.chainId,
          rec.pair,
          50,
          indexerFetchFn,
          cfg.indexerUrl,
          page * 50,
        )
        rows.push(...chunk)
        if (chunk.length < 50) break
      }
    } catch (e) {
      log(`索引器探针查询失败（稍后重试）：${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    const mine = rows.filter((r) => lc(r.txHash) === lc(rec.txHash))
    if (mine.length > 0) {
      const want = rec.events.map(tradeMultisetKey).sort()
      const got = mine
        .map((r) =>
          tradeMultisetKey({
            maker: r.maker,
            taker: r.taker,
            amountIn: r.amountIn,
            amountOut: r.amountOut,
          }),
        )
        .sort()
      if (JSON.stringify(want) === JSON.stringify(got)) {
        rec.probe.indexer = 'ok'
        rec.probe.indexerCheckedAt = Date.now()
        ledger.line({ kind: 'probe-indexer', ts: Date.now(), txHash: rec.txHash, chainId: rec.chainId, result: 'ok' })
      } else {
        rec.probe.indexer = 'mismatch'
        ledger.trip(
          'indexerMismatch',
          `索引器成交与回执事件多重集不符 tx=${rec.txHash} want=${JSON.stringify(want)} got=${JSON.stringify(got)}`,
          { chainId: rec.chainId, txHash: rec.txHash },
        )
      }
      continue
    }
    if (Date.now() - rec.settledAt > cfg.indexerGraceSec * 1000) {
      rec.probe.indexer = 'mismatch'
      ledger.trip(
        'indexerMismatch',
        `索引器在宽限期 ${cfg.indexerGraceSec}s 后仍未收录成交 tx=${rec.txHash}`,
        { chainId: rec.chainId, txHash: rec.txHash },
      )
    }
  }
}

// ---------------------------------------------------------------- 场景层
// 设计文档 §8 阶段 4 全剧本：挂单（落锁时序）→ 吃单 → 结算 → 撤单
// （软+硬）→ 过期释放 → 市价扫簿 → 双 taker 竞态 → 失败归责申报。
// 标准周期覆盖挂单/吃单/结算；其余剧本按周期号低频轮转（与 soak
// 的低频对抗样本同模式）。

interface PendingAction {
  dueAt: number
  label: string
  run: () => Promise<void>
}

interface ExpiryCheck {
  chainId: number
  pair: string
  orderId: string
  digest: string
  expiresAt: number
  stage: 0 | 1
}

const pendingActions: PendingAction[] = []
const expiryChecks: ExpiryCheck[] = []

function bumpScenario(ledger: Stage4Ledger, chainId: number, name: string): void {
  const c = ledger.counts[chainId].scenarios
  c[name] = (c[name] ?? 0) + 1
}

function scenarioLine(ledger: Stage4Ledger, chainId: number, name: string, result: string, detail: string): void {
  ledger.line({ kind: 'scenario', ts: Date.now(), chainId, name, result, detail })
  log(`chain ${chainId} 场景 ${name}: ${result} — ${detail}`)
}

/** 过期单：短存活单投中继，到期后核对中继清理 + 绝不可成交 */
async function scenarioExpiryPost(
  ledger: Stage4Ledger,
  cfg: Stage4Config,
  ctx: ChainCtx,
  pair: string,
): Promise<void> {
  const { gen, skipReason } = await genAndPost(ledger, ctx, cfg.relayUrl, {
    role: 'maker',
    pair,
    side: 'buy',
    amount: '0.0005',
    price: PRICE,
    ttlSec: 150,
  })
  if (!gen) {
    scenarioLine(ledger, ctx.chainId, 'expiry', 'skipped', `生成跳过：${skipReason}`)
    return
  }
  expiryChecks.push({
    chainId: ctx.chainId,
    pair,
    orderId: String(gen.body.orderId),
    digest: gen.digest.toLowerCase(),
    expiresAt: Number(gen.body.expiresAt),
    stage: 0,
  })
  bumpScenario(ledger, ctx.chainId, 'expiryPosted')
  scenarioLine(ledger, ctx.chainId, 'expiry', 'posted', `短存活单已投递，expiresAt=${gen.body.expiresAt}`)
}

async function processExpiryChecks(
  ledger: Stage4Ledger,
  ctxs: Map<number, ChainCtx>,
): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000)
  for (let i = expiryChecks.length - 1; i >= 0; i--) {
    const chk = expiryChecks[i]
    const waitSec = chk.stage === 0 ? 120 : 17 * 60
    if (nowSec < chk.expiresAt + waitSec) continue
    const ctx = ctxs.get(chk.chainId)!
    const book = await ctx.relayAdapter.fetchBook(chk.chainId, chk.pair)
    const present = [...book.bids, ...book.asks].some((o) => o.orderId === chk.orderId)
    if (!present) {
      bumpScenario(ledger, chk.chainId, 'expiryCleaned')
      scenarioLine(ledger, chk.chainId, 'expiry', 'ok', `过期单已被中继清理（stage ${chk.stage}）`)
      expiryChecks.splice(i, 1)
      continue
    }
    if (chk.stage === 0) {
      chk.stage = 1
      scenarioLine(ledger, chk.chainId, 'expiry', 'pending', '过期 +120s 仍在中继簿，等 Worker 清理 cron 窗口（17 分钟）后复查')
      continue
    }
    // 过期 +17 分钟仍在簿：清理失败记 FAIL；同时核对绝不可成交
    ledger.fail({
      ts: Date.now(),
      chainId: chk.chainId,
      kind: 'expired-not-cleaned',
      detail: `过期单在 expiresAt+17min 后仍在中继簿 orderId=${chk.orderId}`,
      digest: chk.digest,
    })
    const round = await runDualReadRound(
      {
        mode: 'shadow',
        nodeAdapter: ctx.nodeAdapter,
        relayAdapter: ctx.relayAdapter,
        chainReader: ctx.chainReader,
      },
      chk.chainId,
      [chk.pair],
    )
    const view = round.views.find((v) => v.pair === chk.pair)
    const inTradeable = view?.tradeable.some(
      (o) => o.identity.digest.toLowerCase() === chk.digest,
    )
    if (inTradeable) {
      ledger.fail({
        ts: Date.now(),
        chainId: chk.chainId,
        kind: 'expired-in-tradeable',
        detail: `过期单仍在可成交集 digest=${chk.digest}`,
        digest: chk.digest,
      })
    }
    expiryChecks.splice(i, 1)
  }
}

/** 篡改注入：改写 side 的副本必须被中继入库验签拒绝；正本随后正常投递 */
async function scenarioTamper(
  ledger: Stage4Ledger,
  cfg: Stage4Config,
  ctx: ChainCtx,
  pair: string,
): Promise<void> {
  const { generated, skipped } = await generateBatch(
    ctx.chainId,
    [ctx.maker, ctx.taker],
    [{ role: 'maker', pair, side: 'sell', amount: '0.0005', price: PRICE }],
    ctx.nonceCursor,
  )
  if (generated.length === 0) {
    scenarioLine(ledger, ctx.chainId, 'tamper', 'skipped', `生成跳过：${skipped[0]?.reason ?? ''}`)
    return
  }
  const gen = generated[0]
  const flipped = gen.side === 'buy' ? ('sell' as const) : ('buy' as const)
  const bad = await postToRelay(cfg.relayUrl, gen, flipped)
  ledger.line({
    kind: 'scenario',
    ts: Date.now(),
    chainId: ctx.chainId,
    name: 'tamper-inject',
    digest: gen.digest.toLowerCase(),
    relayStatus: bad.status,
    relayOk: bad.ok,
  })
  if (bad.ok) {
    ledger.trip('tamperAccepted', `篡改单（side 改写）被中继接受 digest=${gen.digest}`, {
      chainId: ctx.chainId,
      digest: gen.digest,
    })
  }
  const good = await postToRelay(cfg.relayUrl, gen)
  const data = buildSignedOrderData(asRaw(gen), ctx.chainId)
  ledger.posted.set(gen.digest.toLowerCase(), {
    digest: gen.digest.toLowerCase(),
    orderId: String(gen.body.orderId),
    chainId: ctx.chainId,
    pair,
    role: 'maker',
    side: gen.side,
    relayOk: good.ok,
    relayStatus: good.status,
    tampered: false,
    amountIn: data ? data.amountIn : '0',
    expiresAt: Number(gen.body.expiresAt ?? 0),
    postedAt: Date.now(),
  })
  ledger.counts[ctx.chainId].posted += 1
  if (good.ok) ledger.counts[ctx.chainId].relayAccepted += 1
  bumpScenario(ledger, ctx.chainId, 'tamperRejected')
  scenarioLine(
    ledger,
    ctx.chainId,
    'tamper',
    'ok',
    `改写副本被拒（status=${bad.status}），正本投递${good.ok ? '成功' : `失败 status=${good.status}`}`,
  )
}

/** 硬撤单：maker 自锁 → releaseOrderLock → 该单必须再也结不了 */
async function scenarioCancel(
  ledger: Stage4Ledger,
  cfg: Stage4Config,
  ctx: ChainCtx,
  pair: string,
): Promise<void> {
  const { gen, skipReason } = await genAndPost(ledger, ctx, cfg.relayUrl, {
    role: 'maker',
    pair,
    side: 'sell',
    amount: '0.0005',
    price: PRICE,
  })
  if (!gen) {
    scenarioLine(ledger, ctx.chainId, 'cancel', 'skipped', `生成跳过：${skipReason}`)
    return
  }
  const data = buildSignedOrderData(asRaw(gen), ctx.chainId)
  if (!data) {
    scenarioLine(ledger, ctx.chainId, 'cancel', 'skipped', '签名重构失败')
    return
  }
  const vaultWrite = new ethers.Contract(
    ctx.chainCfg.contracts.vault,
    [...VAULT_LOCK_ABI, ...VAULT_EXTRA_ABI] as unknown as ethers.InterfaceAbi,
    ctx.makerSigner,
  )
  const contractOrder = orderDataToContractOrder(data)
  const lockTx = await vaultWrite.lockForOrder(contractOrder, String(gen.body.signature))
  await lockTx.wait()
  const lock = await ctx.vaultRead.orderLocks(gen.digest)
  const remaining = BigInt(lock.remaining ?? lock[2] ?? 0n)
  if (remaining <= 0n) {
    ledger.fail({
      ts: Date.now(),
      chainId: ctx.chainId,
      kind: 'cancel-lock-missing',
      detail: `自锁后 orderLocks.remaining=0 digest=${gen.digest}`,
      digest: gen.digest,
    })
    return
  }
  const relTx = await vaultWrite.releaseOrderLock(gen.digest)
  await relTx.wait()
  // 中继无撤单路由：单仍在中继簿属预期（记录观察），防线是链上过滤
  const book = await ctx.relayAdapter.fetchBook(ctx.chainId, pair)
  const stillListed = [...book.bids, ...book.asks].some(
    (o) => o.orderId === String(gen.body.orderId),
  )
  const attempt = await attemptMatch(ledger, cfg, ctx, {
    role: 'taker',
    pair,
    side: 'buy',
    amount: '0.0005',
    price: PRICE,
  })
  if (attempt.result?.status === 'submitted' && attempt.takerGen) {
    await probeSettlement(ledger, cfg, ctx, pair, attempt.result, attempt.takerGen)
  }
  const filled = (await ctx.settlementRead.orderFilledIn(gen.digest)) as bigint
  if (filled > 0n) {
    ledger.trip('invalidSettle', `已硬撤单的订单被结算 filledIn=${filled} digest=${gen.digest}`, {
      chainId: ctx.chainId,
      digest: gen.digest,
    })
  }
  bumpScenario(ledger, ctx.chainId, 'cancelHeld')
  scenarioLine(
    ledger,
    ctx.chainId,
    'cancel',
    'ok',
    `硬撤单后未被结算（filledIn=0）；中继簿仍列示=${stillListed}（无撤单路由，靠链上墓碑过滤，符合设计 §4.3 口径）`,
  )
}

/** 市价多腿扫簿：三档卖盘 + 一张市价买单，必须多腿成交（整批原子） */
async function scenarioMultileg(
  ledger: Stage4Ledger,
  cfg: Stage4Config,
  ctx: ChainCtx,
  pair: string,
): Promise<void> {
  const ladder: Array<{ price: string }> = [{ price: '1990' }, { price: '2000' }, { price: '2010' }]
  const gens: GeneratedOrder[] = []
  for (const rung of ladder) {
    const { gen } = await genAndPost(ledger, ctx, cfg.relayUrl, {
      role: 'maker',
      pair,
      side: 'sell',
      amount: '0.0004',
      price: rung.price,
    })
    if (gen) gens.push(gen)
  }
  if (gens.length < 2) {
    scenarioLine(ledger, ctx.chainId, 'multileg', 'skipped', `阶梯挂单只生成 ${gens.length} 张`)
    return
  }
  await probePresence(ledger, ctx, pair, gens)
  const attempt = await attemptMatch(ledger, cfg, ctx, {
    role: 'taker',
    pair,
    side: 'buy',
    amount: '0.001',
    price: '2010',
    execType: 'market',
  })
  if (!attempt.result) {
    scenarioLine(ledger, ctx.chainId, 'multileg', 'skipped', 'taker 市价单生成跳过')
    return
  }
  if (attempt.result.status === 'submitted' && attempt.takerGen) {
    await probeSettlement(ledger, cfg, ctx, pair, attempt.result, attempt.takerGen)
  }
  if (attempt.result.status === 'submitted' && attempt.result.legsKept >= 2) {
    bumpScenario(ledger, ctx.chainId, 'multilegOk')
    scenarioLine(ledger, ctx.chainId, 'multileg', 'ok', `市价扫簿 ${attempt.result.legsKept} 腿整批成交 tx=${attempt.result.txHash}`)
  } else {
    ledger.fail({
      ts: Date.now(),
      chainId: ctx.chainId,
      kind: 'multileg-degraded',
      detail: `市价扫簿未多腿成交：status=${attempt.result.status} legs=${attempt.result.legsKept}（${attempt.result.message.slice(0, 100)}）`,
    })
    scenarioLine(ledger, ctx.chainId, 'multileg', 'fail', `status=${attempt.result.status} legs=${attempt.result.legsKept}`)
  }
}

/** 双 taker 竞态：两张 taker 单并发吃同一张 maker 单，总成交不得超签名量 */
async function scenarioRace(
  ledger: Stage4Ledger,
  cfg: Stage4Config,
  ctx: ChainCtx,
  pair: string,
): Promise<void> {
  const { gen: makerGen, skipReason } = await genAndPost(ledger, ctx, cfg.relayUrl, {
    role: 'maker',
    pair,
    side: 'sell',
    amount: '0.001',
    price: PRICE,
  })
  if (!makerGen) {
    scenarioLine(ledger, ctx.chainId, 'race', 'skipped', `maker 生成跳过：${skipReason}`)
    return
  }
  await probePresence(ledger, ctx, pair, [makerGen])
  const takerGens: GeneratedOrder[] = []
  for (let k = 0; k < 2; k++) {
    const { gen } = await genAndPost(ledger, ctx, cfg.relayUrl, {
      role: 'taker',
      pair,
      side: 'buy',
      amount: '0.001',
      price: PRICE,
    })
    if (gen) takerGens.push(gen)
  }
  if (takerGens.length < 2) {
    scenarioLine(ledger, ctx.chainId, 'race', 'skipped', 'taker 单不足两张')
    return
  }
  const runOne = async (gen: GeneratedOrder) => {
    const data = buildSignedOrderData(asRaw(gen), ctx.chainId)
    if (!data) return { status: 'aborted' as const, legsKept: 0, message: '重构失败' }
    const outcome = await executeFrontendMatch(
      {
        chainId: ctx.chainId,
        pair,
        takerData: data,
        takerSignature: String(gen.body.signature),
        signer: ctx.takerSigner,
      },
      {
        nodeAdapter: ctx.nodeAdapter,
        relayAdapter: ctx.relayAdapter,
        chainReader: ctx.chainReader,
      },
    )
    return outcome
  }
  const outcomes = await Promise.allSettled(takerGens.map(runOne))
  // 竞态成交的 tx 同样过结算探针（回执/事件/索引器口径不减）
  for (let k = 0; k < outcomes.length; k++) {
    const o = outcomes[k]
    if (o.status === 'fulfilled' && o.value.status === 'submitted' && o.value.txHash) {
      await probeSettlement(
        ledger,
        cfg,
        ctx,
        pair,
        {
          status: 'submitted',
          txHash: o.value.txHash,
          legsKept: o.value.legsKept,
          legsPruned: o.value.legsPruned,
          message: o.value.message,
        },
        takerGens[k],
      )
    }
  }
  const filled = (await ctx.settlementRead.orderFilledIn(makerGen.digest)) as bigint
  const makerData = buildSignedOrderData(asRaw(makerGen), ctx.chainId)
  const signed = makerData ? BigInt(makerData.amountIn) : 0n
  const submitted = outcomes.filter(
    (o) => o.status === 'fulfilled' && o.value.status === 'submitted',
  ).length
  ledger.line({
    kind: 'scenario',
    ts: Date.now(),
    chainId: ctx.chainId,
    name: 'race',
    makerDigest: makerGen.digest.toLowerCase(),
    filledIn: filled.toString(),
    signedAmountIn: signed.toString(),
    submittedPaths: submitted,
    outcomes: outcomes.map((o) =>
      o.status === 'fulfilled' ? o.value.status : `error:${String(o.reason).slice(0, 80)}`,
    ),
  })
  if (signed > 0n && filled > signed) {
    ledger.trip('invalidSettle', `竞态下 maker 已成交量 ${filled} 超签名量 ${signed}`, {
      chainId: ctx.chainId,
      digest: makerGen.digest,
    })
  }
  if (submitted === 0) {
    ledger.fail({
      ts: Date.now(),
      chainId: ctx.chainId,
      kind: 'race-no-settle',
      detail: '竞态两路均未成交（maker 单在簿、余额与锁均正常时不应发生）',
      digest: makerGen.digest,
    })
    scenarioLine(ledger, ctx.chainId, 'race', 'fail', '两路均未成交')
    return
  }
  bumpScenario(ledger, ctx.chainId, 'raceHeld')
  scenarioLine(
    ledger,
    ctx.chainId,
    'race',
    'ok',
    `并发 ${submitted} 路成交，总成交 ${filled}/${signed} 未超签名量（败路按发起者自担口径收场）`,
  )
}

/**
 * 失败归责申报（尽力剧本，证据优先）：maker 单自锁 → 过期 →
 * releaseExpiredOrderLock 落墓碑 → taker 结算必 revert（先 staticCall
 * 取证、再实发一笔失败 tx）→ owner 钥调 chargeFailedSettlement
 * （FAIL_ORDER_EXPIRED）。任一步偏离预期都逐字记录，不作零容忍。
 */
async function scenarioAttribution(
  ledger: Stage4Ledger,
  cfg: Stage4Config,
  ctx: ChainCtx,
  pair: string,
): Promise<void> {
  const { gen, skipReason } = await genAndPost(ledger, ctx, cfg.relayUrl, {
    role: 'maker',
    pair,
    side: 'sell',
    amount: '0.0005',
    price: PRICE,
    ttlSec: 150,
  })
  if (!gen) {
    scenarioLine(ledger, ctx.chainId, 'attribution', 'skipped', `生成跳过：${skipReason}`)
    return
  }
  const data = buildSignedOrderData(asRaw(gen), ctx.chainId)
  if (!data) {
    scenarioLine(ledger, ctx.chainId, 'attribution', 'skipped', '签名重构失败')
    return
  }
  const vaultWrite = new ethers.Contract(
    ctx.chainCfg.contracts.vault,
    [...VAULT_LOCK_ABI, ...VAULT_EXTRA_ABI] as unknown as ethers.InterfaceAbi,
    ctx.makerSigner,
  )
  const lockTx = await vaultWrite.lockForOrder(
    orderDataToContractOrder(data),
    String(gen.body.signature),
  )
  await lockTx.wait()
  const digest = gen.digest
  const makerData = data
  const makerSig = String(gen.body.signature)
  pendingActions.push({
    dueAt: (Number(gen.body.expiresAt) + 30) * 1000,
    label: `attribution:${ctx.chainId}:${digest.slice(0, 10)}`,
    run: async () => {
      const steps: Record<string, string> = {}
      try {
        const relTx = await vaultWrite.releaseExpiredOrderLock(digest)
        const relReceipt = await relTx.wait()
        steps.releaseExpired = `tx=${relReceipt?.hash} status=${relReceipt?.status}`
      } catch (e) {
        steps.releaseExpired = `error: ${e instanceof Error ? e.message.slice(0, 140) : String(e)}`
      }
      // 组 taker 单 + Fill（fills.ts 同口径内联，与 stage3-e2e 驱动同法）
      const { generated } = await generateBatch(
        ctx.chainId,
        [ctx.maker, ctx.taker],
        [{ role: 'taker', pair, side: 'buy', amount: '0.0005', price: PRICE }],
        ctx.nonceCursor,
      )
      if (generated.length === 0) {
        scenarioLine(ledger, ctx.chainId, 'attribution', 'blocked', `taker 生成跳过；steps=${JSON.stringify(steps)}`)
        return
      }
      const takerData = buildSignedOrderData(asRaw(generated[0]), ctx.chainId)!
      const fill = {
        makerOrder: { order: orderDataToContractOrder(makerData), signature: makerSig },
        takerOrder: {
          order: orderDataToContractOrder(takerData),
          signature: String(generated[0].body.signature),
        },
        tokenIn: makerData.tokenIn,
        tokenOut: makerData.tokenOut,
        amountIn: BigInt(makerData.amountIn),
        amountOut: BigInt(makerData.amountOut),
        gasReimburseIn: 0n,
        gasReimburseOut: 0n,
      }
      const settleTaker = new ethers.Contract(
        ctx.chainCfg.contracts.settlement,
        SETTLEMENT_ABI as unknown as ethers.InterfaceAbi,
        ctx.takerSigner,
      )
      try {
        await settleTaker.settleTrade.staticCall(fill)
        steps.staticCall = 'UNEXPECTED-SUCCESS'
      } catch (e) {
        steps.staticCall = `reverted: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`
      }
      let failGasUsed: bigint | null = null
      try {
        const tx = await settleTaker.settleTrade(fill, { gasLimit: 1_500_000n })
        const rc = await tx.wait()
        steps.realTx = `tx=${rc?.hash} status=${rc?.status}`
        if (rc && rc.status === 1) {
          const filled = (await ctx.settlementRead.orderFilledIn(digest)) as bigint
          if (filled > 0n) {
            ledger.trip('invalidSettle', `过期单被成功结算 filledIn=${filled} digest=${digest}`, {
              chainId: ctx.chainId,
              digest,
              txHash: rc.hash,
            })
          }
          ledger.fail({
            ts: Date.now(),
            chainId: ctx.chainId,
            kind: 'attribution-unexpected-settle',
            detail: `过期单结算 tx 成功但 filledIn=0（口径异常）tx=${rc.hash}`,
            digest,
          })
        } else if (rc) {
          failGasUsed = rc.gasUsed
        }
      } catch (e) {
        steps.realTx = `send-error: ${e instanceof Error ? e.message.slice(0, 140) : String(e)}`
      }
      if (failGasUsed !== null) {
        try {
          const settleOwner = new ethers.Contract(
            ctx.chainCfg.contracts.settlement,
            CHARGE_FAILED_ABI as unknown as ethers.InterfaceAbi,
            ctx.deployerSigner,
          )
          const chargeTx = await settleOwner.chargeFailedSettlement(
            { order: orderDataToContractOrder(makerData), signature: makerSig },
            FAIL_ORDER_EXPIRED,
            failGasUsed,
          )
          const crc = await chargeTx.wait()
          steps.charge = `tx=${crc?.hash} status=${crc?.status}`
        } catch (e) {
          steps.charge = `error: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`
        }
      } else {
        steps.charge = 'skipped（无失败回执 gasUsed）'
      }
      const executed = steps.charge.startsWith('tx=') && steps.charge.includes('status=1')
      bumpScenario(ledger, ctx.chainId, executed ? 'attributionExecuted' : 'attributionRecorded')
      scenarioLine(
        ledger,
        ctx.chainId,
        'attribution',
        executed ? 'ok' : 'recorded',
        JSON.stringify(steps),
      )
    },
  })
  bumpScenario(ledger, ctx.chainId, 'attributionScheduled')
  scenarioLine(ledger, ctx.chainId, 'attribution', 'scheduled', `已自锁并排入到期后执行（expiresAt=${gen.body.expiresAt}）`)
}

async function processPendingActions(ledger: Stage4Ledger): Promise<void> {
  for (let i = pendingActions.length - 1; i >= 0; i--) {
    if (Date.now() < pendingActions[i].dueAt) continue
    const action = pendingActions[i]
    pendingActions.splice(i, 1)
    try {
      await action.run()
    } catch (e) {
      if (e instanceof ZeroToleranceError) throw e
      ledger.fail({
        ts: Date.now(),
        chainId: 0,
        kind: 'pending-action-error',
        detail: `${action.label}: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`,
      })
    }
  }
}

// ------------------------------------------------------------- 周期编排

async function runChainCycle(
  ledger: Stage4Ledger,
  cfg: Stage4Config,
  ctx: ChainCtx,
  cycle: number,
): Promise<void> {
  // 多腿市价剧本整周期替换标准流（每 8 周期一次）
  if (cycle % 8 === 7) {
    const pair = TRADE_PAIRS[(cycle - 1) % TRADE_PAIRS.length]
    await scenarioMultileg(ledger, cfg, ctx, pair)
    ledger.line({ kind: 'cycle', ts: Date.now(), chainId: ctx.chainId, cycle, pair, mode: 'multileg' })
    return
  }
  const pair = TRADE_PAIRS[(cycle - 1) % TRADE_PAIRS.length]
  const tryMakers = async (p: string): Promise<GeneratedOrder[]> => {
    const gens: GeneratedOrder[] = []
    for (const side of ['sell', 'buy'] as const) {
      const { gen } = await genAndPost(ledger, ctx, cfg.relayUrl, {
        role: 'maker',
        pair: p,
        side,
        amount: '0.001',
        price: PRICE,
      })
      if (gen) gens.push(gen)
      if (cfg.submitGapMs > 0) await sleep(cfg.submitGapMs)
    }
    return gens
  }
  let usedPair = pair
  let makerGens = await tryMakers(pair)
  if (makerGens.length === 0 && pair !== DEFAULT_PAIR) {
    // 该对在该链未登记或钱包无可落锁余额：回落默认对保产出（与 soak 的预检跳过口径一致，差别是阶段 4 有计数目标）
    log(`chain ${ctx.chainId} cycle ${cycle}: ${pair} 无单可发，回落 ${DEFAULT_PAIR}`)
    usedPair = DEFAULT_PAIR
    makerGens = await tryMakers(DEFAULT_PAIR)
  }
  if (makerGens.length > 0) await probePresence(ledger, ctx, usedPair, makerGens)

  for (const side of ['buy', 'sell'] as const) {
    const attempt = await attemptMatch(ledger, cfg, ctx, {
      role: 'taker',
      pair: usedPair,
      side,
      amount: '0.001',
      price: PRICE,
    })
    if (attempt.result?.status === 'submitted' && attempt.takerGen) {
      await probeSettlement(ledger, cfg, ctx, usedPair, attempt.result, attempt.takerGen)
    }
  }

  // 低频剧本轮转（add-on，各自独立记账）
  if (cycle % 6 === 5) await scenarioExpiryPost(ledger, cfg, ctx, usedPair)
  if (cycle % 10 === 9) await scenarioCancel(ledger, cfg, ctx, usedPair)
  if (cycle % 12 === 11) await scenarioTamper(ledger, cfg, ctx, usedPair)
  if (cycle % 16 === 15) await scenarioRace(ledger, cfg, ctx, usedPair)
  if (cycle % 24 === 23) await scenarioAttribution(ledger, cfg, ctx, usedPair)

  ledger.line({ kind: 'cycle', ts: Date.now(), chainId: ctx.chainId, cycle, pair: usedPair, mode: 'standard' })
}

// ---------------------------------------------------------------- run

export async function runStage4(cfg: Stage4Config): Promise<number> {
  const wallets = loadWallets(cfg.keysDir)
  const deployer = loadDeployer(cfg.keysDir)
  const ctxs = new Map<number, ChainCtx>()
  for (const chainId of CHAINS) {
    ctxs.set(chainId, buildChainCtx(cfg, chainId, wallets, deployer))
  }
  const metricsPath = join(cfg.outDir, 'stage4-metrics.jsonl')
  const statePath = join(cfg.outDir, 'stage4-state.json')
  const windowStart = Date.now()
  const ledger = new Stage4Ledger(
    metricsPath,
    statePath,
    windowStart,
    windowStart + cfg.maxHours * 3600_000,
  )
  ledger.line({
    kind: 'window-start',
    ts: windowStart,
    buildNote: BUILD_NOTE,
    windowEndPlanned: ledger.windowEndPlanned,
    relayUrl: cfg.relayUrl,
    indexerUrl: cfg.indexerUrl || '(unset)',
    intervalSec: cfg.intervalSec,
    targetPerChain: cfg.targetPerChain,
    chains: CHAINS.map((c) => ({
      chainId: c,
      settlement: getChainConfig(c)?.contracts.settlement,
      vault: getChainConfig(c)?.contracts.vault,
    })),
  })
  ledger.saveState('running')
  log(
    `阶段 4 运行器启动：窗口 ${new Date(windowStart).toISOString()} → ${new Date(ledger.windowEndPlanned).toISOString()}，` +
      `间隔 ${cfg.intervalSec}s，目标每链 ≥${cfg.targetPerChain} 单`,
  )
  log(BUILD_NOTE)
  let stopping = false
  const onSig = () => {
    stopping = true
    log('收到停止信号，本周期结束后优雅停跑（状态已落盘）')
  }
  process.on('SIGTERM', onSig)
  process.on('SIGINT', onSig)
  try {
    while (!stopping && Date.now() < ledger.windowEndPlanned) {
      const cycleStart = Date.now()
      ledger.cycles += 1
      const cycle = ledger.cycles
      await processPendingActions(ledger)
      await processExpiryChecks(ledger, ctxs)
      for (const chainId of CHAINS) {
        try {
          await withTimeout(
            runChainCycle(ledger, cfg, ctxs.get(chainId)!, cycle),
            CHAIN_CYCLE_TIMEOUT_MS,
            `chain ${chainId} cycle ${cycle}`,
          )
        } catch (e) {
          if (e instanceof ZeroToleranceError) throw e
          ledger.fail({
            ts: Date.now(),
            chainId,
            kind: 'cycle-error',
            detail: e instanceof Error ? e.message.slice(0, 200) : String(e),
          })
        }
      }
      try {
        await withTimeout(
          recheckIndexerProbes(ledger, cfg, ctxs),
          RECHECK_TIMEOUT_MS,
          '索引器探针复查',
        )
      } catch (e) {
        if (e instanceof ZeroToleranceError) throw e
        ledger.fail({
          ts: Date.now(),
          chainId: 0,
          kind: 'probe-recheck-error',
          detail: e instanceof Error ? e.message.slice(0, 200) : String(e),
        })
      }
      ledger.saveState('running')
      const c1 = ledger.counts[11155111]
      const c2 = ledger.counts[84532]
      log(
        `cycle ${cycle} 完成（${Math.round((Date.now() - cycleStart) / 1000)}s）：` +
          `Sepolia 接单 ${c1.relayAccepted}/结算 ${c1.settlements}，Base 接单 ${c2.relayAccepted}/结算 ${c2.settlements}`,
      )
      const wait = Math.max(0, cfg.intervalSec * 1000 - (Date.now() - cycleStart))
      let slept = 0
      while (!stopping && slept < wait && Date.now() < ledger.windowEndPlanned) {
        const step = Math.min(15_000, wait - slept)
        await sleep(step)
        slept += step
        await processPendingActions(ledger)
      }
    }
  } catch (e) {
    if (e instanceof ZeroToleranceError) {
      log(`零容忍触发，停跑保全证据：${e.message}`)
      ledger.saveState('zero-tolerance-triggered')
      return 3
    }
    throw e
  }
  // 收尾复查：给索引器 pending 探针最后一次机会（超宽限的会在此触发）
  await sleep(30_000)
  try {
    await withTimeout(
      recheckIndexerProbes(ledger, cfg, ctxs),
      RECHECK_TIMEOUT_MS,
      '收尾索引器探针复查',
    )
  } catch (e) {
    if (e instanceof ZeroToleranceError) {
      ledger.saveState('zero-tolerance-triggered')
      return 3
    }
    log(`收尾复查未完成（不阻断收尾记账）：${e instanceof Error ? e.message.slice(0, 200) : String(e)}`)
  }
  ledger.line({ kind: 'window-end', ts: Date.now(), cycles: ledger.cycles })
  ledger.saveState(stopping ? 'stopped-by-signal' : 'completed')
  log(`阶段 4 运行器结束：共 ${ledger.cycles} 周期，状态=${stopping ? 'stopped-by-signal' : 'completed'}`)
  return 0
}

// -------------------------------------------------------------- check

/** 只读预检：不签任何单、不发任何交易；Phase X 发令前摸清环境 */
export async function runCheck(cfg: Stage4Config): Promise<number> {
  let hardFail = false
  const report: Record<string, unknown> = {
    ts: new Date().toISOString(),
    relayUrl: cfg.relayUrl,
    indexerUrl: cfg.indexerUrl || '(unset)',
    keysDir: cfg.keysDir,
  }
  try {
    const r = await fetch(`${cfg.relayUrl}/health`, { signal: AbortSignal.timeout(10_000) })
    report.relayHealth = { status: r.status, body: (await r.text()).slice(0, 120) }
    if (!r.ok) hardFail = true
  } catch (e) {
    report.relayHealth = { error: e instanceof Error ? e.message : String(e) }
    hardFail = true
  }
  let wallets: SoakWallet[] = []
  let deployer: SoakWallet | null = null
  try {
    wallets = loadWallets(cfg.keysDir)
    deployer = loadDeployer(cfg.keysDir)
    report.addresses = {
      maker: wallets.find((w) => w.role === 'maker')?.address,
      taker: wallets.find((w) => w.role === 'taker')?.address,
      deployer: deployer.address,
    }
  } catch (e) {
    report.keysError = e instanceof Error ? e.message : String(e)
    hardFail = true
  }
  if (!hardFail) {
    for (const chainId of CHAINS) {
      const ctx = buildChainCtx(cfg, chainId, wallets, deployer!)
      const info: Record<string, unknown> = {
        contracts: ctx.chainCfg.contracts,
        rpcUrl: ctx.chainCfg.rpcUrl,
      }
      try {
        info.blockNumber = await ctx.provider.getBlockNumber()
        const code = await ctx.provider.getCode(ctx.chainCfg.contracts.settlement)
        info.settlementHasCode = code !== '0x'
        if (!info.settlementHasCode) hardFail = true
      } catch (e) {
        info.rpcError = e instanceof Error ? e.message : String(e)
        hardFail = true
      }
      const balances: Record<string, string> = {}
      for (const w of [ctx.maker, ctx.taker, ctx.deployer]) {
        try {
          balances[w.address] = ethers.formatEther(await ctx.provider.getBalance(w.address))
        } catch {
          balances[w.address] = '(error)'
        }
      }
      info.nativeBalances = balances
      const tokens = getPairTokens(chainId, DEFAULT_PAIR)
      if (tokens) {
        const avail: Record<string, unknown> = {}
        for (const w of [ctx.maker, ctx.taker]) {
          avail[w.role] = {
            base: (await vaultAvailable(chainId, w.address, tokens.base)).toString(),
            quote: (await vaultAvailable(chainId, w.address, tokens.quote)).toString(),
          }
        }
        info.defaultPairVaultAvailable = avail
      }
      try {
        const r = await fetch(`${cfg.nodeUrls[chainId]}/api/health`, {
          signal: AbortSignal.timeout(4_000),
        })
        info.nodeLocal = `up (http ${r.status})`
      } catch (e) {
        info.nodeLocal = `down (${e instanceof Error ? e.message.slice(0, 60) : String(e)})`
      }
      try {
        const book = await ctx.relayAdapter.fetchBook(chainId, DEFAULT_PAIR)
        info.relayBook = { bids: book.bids.length, asks: book.asks.length, complete: book.complete }
      } catch (e) {
        info.relayBook = { error: e instanceof Error ? e.message : String(e) }
      }
      if (cfg.indexerUrl) {
        try {
          const rows = await fetchIndexerTrades(chainId, DEFAULT_PAIR, 1, indexerFetchFn, cfg.indexerUrl)
          info.indexer = { ok: true, sampleRows: rows.length }
        } catch (e) {
          info.indexer = { ok: false, error: e instanceof Error ? e.message.slice(0, 120) : String(e) }
        }
      } else {
        info.indexer = { ok: false, error: 'S4_INDEXER_URL 未设置（go 时由主聊天给最终端点）' }
      }
      report[`chain_${chainId}`] = info
    }
  }
  console.log(JSON.stringify(report, null, 2))
  if (hardFail) console.error('[stage4] check: 存在硬失败项（见上）')
  return hardFail ? 1 : 0
}
