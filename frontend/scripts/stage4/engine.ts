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
 * 被中继接受。第 45 轮 B4 起同级再加一条：结算状态未知——已提交
 * 的结算在宽限内查不到回执、或关键链上读数重试后仍失败，按失败
 * 关闭停机（提交结果不明，绝不带着未知状态继续跑）。
 *
 * 索引器不在零容忍线内（Ren 2026-11-09 09:13 口径：平台只是
 * 中介，交易都在链上，索引器只是展示缓存、不是账本）：索引器
 * 滞后或字段不符只记观察项（probe-indexer 的 lagging /
 * mismatch-observed），不停机；正确性一律以链上回执与事件为准。
 * zero.indexerMismatch 计数仅为状态结构历史兼容保留，不再递增。
 *
 * 第 48 轮（第 45 轮运行器半复审 P1/P2 修复）：① txHash 到手先记
 * 恢复账本再探回执（窗口期被杀不丢账）；② 周期超时后本链进隔离
 * 状态，下一周期前先对账（遗留待确认结算复查 + 链上事件扫描认回
 * 迟到广播的成交），对完账才许提新单；③ 恢复账本文件存在但损坏
 * = 失败关闭（PendingLedgerCorruptError），不再静默当空账本；
 * ④ 确认记账顺序定版：先写 probe/恢复记录再清 pending，恢复路径
 * 的已成交量读取与主路径同等 3 次重试，签名量缺失不得跳过核对；
 * ⑤ 中继发单超时标「接受状态未知」并纳入在场探针，中继拉簿把
 * 真实 AbortSignal 经适配器 fetchFn 注入点传进底层 fetch（不再
 * 只是等超时），relay.postOrder 打点覆盖到响应体读取。
 *
 * 第 50 轮（第 48 轮推送后 ChatGPT 复审条件项统一修复）：① 隔离
 * 对账遇回执未验真的迟到成交不再报 complete——抛错保隔离、失败
 * 关闭；② 恢复账本主文件缺失时读遗留 `.tmp` 兜底首次创建崩溃
 * 窗（校验不过即失败关闭）；③ 跨进程幂等判重补 metrics 落盘
 * probe 记录（hasProbeRecord），重启不重复确认/记账；④ 恢复
 * 账本改全字段 schema 校验，同 txHash 异内容冲突 = 失败关闭，
 * 禁止静默覆盖。
 *
 * 第 52 轮（第 50 轮推送后 ChatGPT 复审条件项修复）：① 隔离对账
 * 认回迟到成交须再过事件对账——回执解析出的成交事件必须非空且
 * 多重集覆盖事件扫描的发现（回执解析本已保证事件来自目标
 * Settlement 合约），对不上按未验真保隔离；② 恢复账本落盘补
 * fsync 持久化序（写 tmp → 同步文件 → rename → 同步父目录），
 * 保证范围扩到掉电/系统崩溃（以 fsync 语义为限）；③ 全字段校
 * 验补语义层（链/交易对白名单、哈希格式、腿数 ≥1、量为十进制
 * 整数串、记账时间为正数）。
 *
 * 密钥纪律：只从 S4_KEYS_DIR（默认 ~/workspace/bite100-deployer）
 * 的 maker.env / taker.env / wallet.env 运行时读取，绝不打印/落盘。
 * 仅测试网链（11155111 / 84532），其他 chainId 直接拒绝。
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
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
  type FetchFn,
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

/**
 * 超时错误分类（第 48 轮）：AbortSignal.timeout 触发的 TimeoutError、
 * 主动取消的 AbortError、本模块的 CycleTimeoutError、以及消息含
 * timeout/timed out 的错误都归「超时」。慢 ≠ 错：拉簿/发单超时只
 * 说明等不到结果（接受状态未知/源无结论），不得按业务失败下结论，
 * 分类供记账与探针分支使用。
 */
export function isTimeoutError(e: unknown): boolean {
  if (e instanceof CycleTimeoutError) return true
  if (!(e instanceof Error)) return false
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true
  return /timed?\s*out|timeout/i.test(e.message)
}

// ------------------------------------------------------- 调用打点
/**
 * 卡点隔离埋点（第 45 轮块 1）：阶段 4 实测中 Sepolia 周期 2 起会
 * 卡死在一个无超时的网络等待上，但从未隔离到具体调用。本埋点给
 * 周期路径上的每个网络调用命名并计时：调用前先同步落一行
 * call-start（ledger.line 走 appendFileSync，同步写盘——进程即使
 * 随后永久挂死，这行也已在 metrics 里），结束落 call-end（耗时 +
 * 成败）。下轮运行若再卡死，metrics 中最后一个未配对的 call-start
 * 的 call 名即卡住的调用，ms 缺失本身就是证据。sink 由 runStage4
 * 在 ledger 建好后注入；check 模式不注入（只执行、不打点）。
 */
let traceSink: ((line: Record<string, unknown>) => void) | null = null

export function setTraceSink(
  fn: ((line: Record<string, unknown>) => void) | null,
): void {
  traceSink = fn
}

async function traceCall<T>(
  call: string,
  chainId: number,
  fn: () => Promise<T>,
): Promise<T> {
  if (!traceSink) return fn()
  const startedAt = Date.now()
  traceSink({ kind: 'call-start', ts: startedAt, chainId, call })
  try {
    const out = await fn()
    traceSink({
      kind: 'call-end',
      ts: Date.now(),
      chainId,
      call,
      ms: Date.now() - startedAt,
      ok: true,
    })
    return out
  } catch (e) {
    traceSink({
      kind: 'call-end',
      ts: Date.now(),
      chainId,
      call,
      ms: Date.now() - startedAt,
      ok: false,
      error: (e instanceof Error ? e.message : String(e)).slice(0, 160),
    })
    throw e
  }
}
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
  /** 第 48 轮：发单请求超时——中继可能已接单也可能没收到，接受状态未知；在场探针须一并核查 */
  relayUnknown?: boolean
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
  /** 索引器滞后观察项是否已记过（每笔只记一次，probe 本身保持 pending 继续复查） */
  lagReported?: boolean
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

/** B5 恢复账本条目：已提交但未探针确认的结算（落盘 stage4-pending-settlements.json） */
export interface PendingSettlement {
  txHash: string
  chainId: number
  pair: string
  takerDigest: string
  legs: number
  takerAmountIn: string | null
  notedAt: number
}

export class ZeroToleranceError extends Error {}

/**
 * 恢复账本损坏错误（第 48 轮 P1-3）：账本文件存在但解析失败/形状
 * 不对时抛出。旧实现吞掉一切错误返回空账本，损坏被静默当作「无
 * 遗留结算」继续跑——已提交未确认的结算就此丢账。定版口径：文件
 * 不存在 = 空账本（正常）；存在但读不懂 = 失败关闭（属零容忍类），
 * 由 runStage4 启动路径按 zero-tolerance-triggered 收尾停机。
 */
export class PendingLedgerCorruptError extends Error {
  constructor(detail: string) {
    super(`恢复账本损坏（失败关闭）：${detail}`)
    this.name = 'PendingLedgerCorruptError'
  }
}

/** 构建备注：第 52 轮定版（叠加第 50/48/45 轮），随状态文件与 window-start 行落盘 */
export const BUILD_NOTE = '第 52 轮审查条件项修复（基线第 50 轮）：迟到成交回执事件须与扫描发现多重集对账（空/不符按未验真保隔离）；恢复账本 fsync 持久化序（写 tmp→同步文件→rename→同步父目录）+ 语义校验（链白名单/交易对白名单/哈希与摘要格式/腿数 ≥1/量为十进制整数串）。第 50 轮审查条件项修复（基线第 48 轮）：隔离对账遇未验真迟到成交不报 complete、抛错保隔离（失败关闭）；恢复账本主文件缺失时读遗留 .tmp 兜底首次创建崩溃窗；恢复账本全字段 schema 校验 + 同 txHash 异内容冲突失败关闭；跨进程幂等判重补 metrics 落盘 probe 记录，重启不重复确认。第 48 轮运行器修复（叠加第 45 轮 B1/B3/B2-lite + 方案 B 超时硬化 + 卡点埋点 + B4 失败关闭 + B5 恢复账本）：P1-1 txHash 先记账本再探回执；P1-2 周期超时后本链隔离、下一周期前先对账（遗留结算复查 + 事件扫描认回迟到成交）才许提新单；P1-3 恢复账本损坏 = 失败关闭停机；P2 确认记账顺序（先写记录再清 pending、启动幂等合并）、恢复路径已成交量 3 次重试、签名量缺失不跳过核对、中继拉簿真实 AbortSignal 注入、发单超时标接受未知并入在场探针、postOrder 打点覆盖响应体读取'

/**
 * 原子写 + 掉电持久化（第 52 轮 B2）：写 `.tmp` → fsync 文件 →
 * rename → fsync 父目录。rename 本身只保证进程崩溃/被杀时读者
 * 要么见旧文件、要么见新文件（原子替换）；数据真落盘要靠
 * fsync——没有它，掉电/系统崩溃时已 rename 的文件内容仍可能
 * 随页缓存一起丢。fsync 在个别平台/文件系统上可能不支持（尤
 * 其目录 fsync）：本助手降级为尽力而为——同步失败只跳过该步、
 * 不拦写入；保证范围以 fsync 语义为限，README「运行约束」有
 * 明文（进程崩溃恒保、掉电以 fsync 成功为限）。
 */
function writeFileAtomicDurable(path: string, data: string): void {
  const tmp = `${path}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, data)
    try {
      fsyncSync(fd)
    } catch {
      // 降级：本平台文件 fsync 不可用时跳过（见函数头）
    }
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
  try {
    const dfd = openSync(dirname(path), 'r')
    try {
      fsyncSync(dfd)
    } catch {
      // 降级：目录 fsync 不被支持时跳过（见函数头）
    } finally {
      closeSync(dfd)
    }
  } catch {
    // 父目录句柄打不开：跳过目录同步，不拦业务
  }
}

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

  private pending = new Map<string, PendingSettlement>()

  constructor(
    private readonly metricsPath: string,
    private readonly statePath: string,
    private readonly pendingPath: string,
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

  /** B5：登记一笔待确认结算并立即落盘（第 52 轮起 persistPending 走 fsync 持久化序，见 writeFileAtomicDurable） */
  notePending(entry: PendingSettlement): void {
    this.pending.set(entry.txHash.toLowerCase(), entry)
    this.persistPending()
  }

  /** B5：结算已按链上口径确认完毕 → 从恢复账本清除 */
  confirmPending(txHash: string): void {
    if (this.pending.delete(txHash.toLowerCase())) this.persistPending()
  }

  /**
   * 第 50 轮：单行全字段 schema 校验——账本条目的每个必填字段逐一
   * 验类型/存在，任一不符即按账本损坏失败关闭。第 48 轮 P1-3 的
   * 浅校验只验 txHash/chainId 两项，缺腿数/缺签名量/缺摘要的半残
   * 条目会被放行、到恢复确认时才爆，且爆点远离损坏源。
   *
   * 第 52 轮 B3：在类型校验之上补语义校验（字段齐全 ≠ 语义合法）：
   * - txHash / takerDigest 必须是 0x + 64 位 hex（交易哈希与
   *   bytes32 摘要的固定形态）；
   * - chainId 必须为正整数且 ∈ CHAINS（本运行器的测试网白名单，
   *   与「只允许测试网链」的既有门禁同一集合）；
   * - pair 必须 ∈ TRADE_PAIRS（运行器周期轮转的已知交易对集合，
   *   创建点 probeSettlement 传入的 pair 只来自该轮转）；
   * - legs 必须为整数且 ≥1（创建点 legs = attempt.legsKept：已
   *   提交结算的保留腿数，提交成功即至少 1 腿，0/负数/小数都
   *   不可能由运行器自己写出）；
   * - takerAmountIn 非 null 时必须为十进制整数字符串（wei 量，
   *   创建点取签名订单的 amountIn 原串）；
   * - notedAt 必须为正数（创建点恒为 Date.now() 毫秒）。
   * 账本由运行器自产，上述每条都与创建点实际取值对齐，不会误杀
   * 自产条目；手改/半写/串话的条目在此失败关闭，爆点即损坏点。
   */
  private static validatePendingRows(parsed: unknown, source: string): PendingSettlement[] {
    if (!Array.isArray(parsed)) {
      throw new PendingLedgerCorruptError(`${source}：内容不是待确认结算数组`)
    }
    const HEX64 = /^0x[0-9a-fA-F]{64}$/
    parsed.forEach((r, i) => {
      const bad = (field: string) =>
        new PendingLedgerCorruptError(`${source}：第 ${i} 行字段 ${field} 缺失、类型不符或值不合法`)
      if (!r || typeof r !== 'object') throw bad('(整行)')
      const row = r as Record<string, unknown>
      if (typeof row.txHash !== 'string' || !HEX64.test(row.txHash)) throw bad('txHash')
      if (
        typeof row.chainId !== 'number' ||
        !Number.isInteger(row.chainId) ||
        !(CHAINS as readonly number[]).includes(row.chainId)
      ) {
        throw bad('chainId')
      }
      if (
        typeof row.pair !== 'string' ||
        !(TRADE_PAIRS as readonly string[]).includes(row.pair)
      ) {
        throw bad('pair')
      }
      if (typeof row.takerDigest !== 'string' || !HEX64.test(row.takerDigest)) {
        throw bad('takerDigest')
      }
      if (typeof row.legs !== 'number' || !Number.isInteger(row.legs) || row.legs < 1) {
        throw bad('legs')
      }
      if (
        !(
          row.takerAmountIn === null ||
          (typeof row.takerAmountIn === 'string' && /^\d+$/.test(row.takerAmountIn))
        )
      ) {
        throw bad('takerAmountIn')
      }
      if (
        typeof row.notedAt !== 'number' ||
        !Number.isFinite(row.notedAt) ||
        row.notedAt <= 0
      ) {
        throw bad('notedAt')
      }
    })
    return parsed as PendingSettlement[]
  }

  /** 两行同 txHash 是否内容一致（逐字段比对，与键序无关） */
  private static samePendingContent(a: PendingSettlement, b: PendingSettlement): boolean {
    return (
      a.chainId === b.chainId &&
      a.pair === b.pair &&
      lc(a.takerDigest) === lc(b.takerDigest) &&
      a.legs === b.legs &&
      a.takerAmountIn === b.takerAmountIn &&
      a.notedAt === b.notedAt
    )
  }

  /**
   * B5：读盘上遗留的待确认结算。第 48 轮 P1-3 定版：文件不存在 =
   * 空账本（正常）；文件存在但解析失败/形状不对 = 抛
   * PendingLedgerCorruptError 失败关闭——账本里是已提交未确认的
   * 结算，读不懂绝不能静默当空账本继续跑。
   *
   * 第 50 轮补三处（第 48 轮复审 P1/P2）：
   * - **首次创建崩溃窗**：persistPending 先写 `.tmp` 再 rename，
   *   进程若被 SIGKILL 卡在两者之间，主文件尚不存在而 `.tmp`
   *   遗留——旧实现直接返回空账本，第一笔已记账结算就此丢失。
   *   主文件缺失时改读遗留 `.tmp`：经全字段校验合法才采用，并
   *   rename 愈合文件布局；校验不过按账本损坏失败关闭。
   * - **全字段校验**：validatePendingRows 逐字段验，不再只验两项。
   * - **同哈希重复条目**：内容相同则合并一条；内容冲突（同哈希
   *   两套说法）抛 PendingLedgerCorruptError，禁止 Map 静默覆盖。
   */
  loadPending(): PendingSettlement[] {
    let raw: string | null = null
    let source = '恢复账本主文件'
    let adoptTmp = false
    if (existsSync(this.pendingPath)) {
      raw = readFileSync(this.pendingPath, 'utf8')
    } else if (existsSync(`${this.pendingPath}.tmp`)) {
      raw = readFileSync(`${this.pendingPath}.tmp`, 'utf8')
      source = '恢复账本 .tmp 遗留文件（主文件缺失，首次创建崩溃窗）'
      adoptTmp = true
    }
    if (raw === null) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      throw new PendingLedgerCorruptError(
        `${source} JSON 解析失败：${e instanceof Error ? e.message : String(e)}`,
      )
    }
    const rows = Stage4Ledger.validatePendingRows(parsed, source)
    if (adoptTmp) {
      // .tmp 内容已验真：rename 愈合布局，后续 persistPending 回到
      // 主文件口径。愈合失败不拦恢复——数据已在手、已在内存，
      // 下一次落盘仍会重写主文件。
      try {
        renameSync(`${this.pendingPath}.tmp`, this.pendingPath)
      } catch {
        // 忽略：见上
      }
    }
    for (const r of rows) {
      const key = r.txHash.toLowerCase()
      const prev = this.pending.get(key)
      if (prev && !Stage4Ledger.samePendingContent(prev, r)) {
        throw new PendingLedgerCorruptError(
          `txHash ${r.txHash} 存在内容冲突的重复条目（同哈希异内容，拒绝静默覆盖）`,
        )
      }
      this.pending.set(key, r)
    }
    return [...this.pending.values()]
  }

  /** 第 48 轮：内存账本快照（隔离对账读遗留待确认结算用，不再回读磁盘） */
  pendingEntries(): PendingSettlement[] {
    return [...this.pending.values()]
  }

  /**
   * 第 50 轮 P2：跨进程幂等判重——metrics JSONL 里是否已有该
   * txHash 的 probe 确认记录行。确认记账顺序是「先写 probe 行、
   * 再清 pending」（第 48 轮 P2），进程恰好死在两者之间时，重启
   * 后内存 settlements 是空的、只查内存的旧判重会把这笔再确认
   * 一遍并重复追加 probe 行，下游按行汇总即双计。metrics 文件
   * 是落盘事实，判重以它兜底。文件不存在或个别行是坏 JSON
   * （半写行）按「无记录」跳过：判重只防重复，读不通不能反过
   * 来把恢复堵死（账本损坏的失败关闭判定在 loadPending）。
   */
  hasProbeRecord(txHash: string): boolean {
    if (!existsSync(this.metricsPath)) return false
    const want = txHash.toLowerCase()
    for (const line of readFileSync(this.metricsPath, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line) as { kind?: unknown; txHash?: unknown }
        if (
          row.kind === 'probe' &&
          typeof row.txHash === 'string' &&
          row.txHash.toLowerCase() === want
        ) {
          return true
        }
      } catch {
        // 坏行跳过，不影响其余行的判重
      }
    }
    return false
  }

  private persistPending(): void {
    // 第 52 轮 B2：走 fsync 持久化序（writeFileAtomicDurable）——
    // 恢复账本里是已提交未确认的结算，掉电也不能丢；saveState 的
    // 运行状态只是汇总快照，维持原 tmp+rename 写法不在本轮面内。
    writeFileAtomicDurable(
      this.pendingPath,
      JSON.stringify([...this.pending.values()], null, 2),
    )
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

const RELAY_BOOK_TIMEOUT_MS = 30_000

/** 簿适配器打点包裹（运行器侧胶水，产品适配器不动）：每次拉簿落 call-start/call-end */
function tracedBookAdapter(inner: BookAdapter, call: string): BookAdapter {
  return {
    fetchBook: (chainId: number, pair: string) =>
      traceCall(call, chainId, () => inner.fetchBook(chainId, pair)),
  }
}

/**
 * 中继拉簿的 fetch 实现（第 48 轮）：经产品适配器既有的 fetchFn
 * 注入点传入，底层 fetch 带真实 AbortSignal.timeout——连接挂死时
 * 30s 到点真正掐断 socket，而不是只在外层「等超时」放弃等待（第
 * 45 轮复审 P2：旧包裹只是 wait-timeout，内层 fetch 不被取消、
 * 挂死连接一直占着）。慢 ≠ 错：超时按拉簿失败/源无结论处理。
 */
const relayFetchWithTimeout: FetchFn = async (url: string) => {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(RELAY_BOOK_TIMEOUT_MS),
  })
  return { ok: res.ok, status: res.status, json: () => res.json() }
}

/**
 * 中继簿适配器：打点 + 外层硬超时兜底。内层 fetch 已带真实信号
 * （见 relayFetchWithTimeout）；withTimeout 保留为第二道保险，防
 * 适配器内部其他环节（json 解析等）挂死时周期被拖住。
 */
function tracedRelayBookAdapter(inner: BookAdapter): BookAdapter {
  return {
    fetchBook: (chainId: number, pair: string) =>
      traceCall('book.relay', chainId, () =>
        withTimeout(
          inner.fetchBook(chainId, pair),
          RELAY_BOOK_TIMEOUT_MS,
          `中继拉簿 chain ${chainId} ${pair}`,
        ),
      ),
  }
}

/** 链上状态读取器打点包裹：snapshot 内部走 viem multicall（自带 http 超时），此处只命名计时 */
function tracedChainReader(inner: ChainStateReader): ChainStateReader {
  return {
    snapshot: (chainId, requests) =>
      traceCall('chain.snapshot', chainId, () => inner.snapshot(chainId, requests)),
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
    nodeAdapter: tracedBookAdapter(createDirectNodeAdapter(cfg.nodeUrls[chainId]), 'book.node'),
    relayAdapter: tracedRelayBookAdapter(
      createRelayBookAdapter(cfg.relayUrl, relayFetchWithTimeout),
    ),
    chainReader: tracedChainReader(createChainStateReader(createViemChainTransport())),
  }
}

// ------------------------------------------------------------- 中继单发

export interface RelayPostResult {
  ok: boolean
  status: number | null
  error?: string
  /**
   * 第 48 轮：错误分类——timeout（等不到回执）/ http（中继明确回
   * 非 2xx）/ network（连接层失败）。慢 ≠ 错：timeout 时中继可能
   * 已经接单，接受状态未知，见 unknown。
   */
  errorKind?: 'timeout' | 'http' | 'network'
  /** 第 48 轮：请求超时导致接受状态未知（单可能已在中继簿里，在场探针须一并核查） */
  unknown?: boolean
}

/**
 * 只投中继（阶段 4 的唯一投递路径；形状与 generator.submitOrder
 * 的中继半边一致）。第 48 轮：traceCall 包裹范围扩到响应体读取
 * （res.text() 也可能挂死，旧版在打点之外）；请求超时不下「未接
 * 单」结论，标 unknown + errorKind=timeout 交在场探针认账。
 */
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
    const out = await traceCall('relay.postOrder', gen.chainId, async () => {
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
    })
    return out.ok ? out : { ...out, errorKind: 'http' as const }
  } catch (e) {
    const timeout = isTimeoutError(e)
    return {
      ok: false,
      status: null,
      error: e instanceof Error ? e.message : String(e),
      errorKind: timeout ? 'timeout' : 'network',
      ...(timeout ? { unknown: true } : {}),
    }
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
  const { generated, skipped } = await traceCall('gen.generateBatch', ctx.chainId, () =>
    generateBatch(ctx.chainId, [ctx.maker, ctx.taker], [spec], ctx.nonceCursor),
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
    relayUnknown: res.unknown || undefined,
    relayStatus: res.status,
    tampered: Boolean(opts.tamper),
    amountIn: data ? data.amountIn : '0',
    expiresAt: Number(gen.body.expiresAt ?? 0),
    postedAt: Date.now(),
  }
  ledger.posted.set(rec.digest, rec)
  ledger.counts[ctx.chainId].posted += 1
  if (res.ok && !opts.tamper) ledger.counts[ctx.chainId].relayAccepted += 1
  ledger.line({ kind: 'posted', ...rec, relayError: res.error, relayErrorKind: res.errorKind })
  if (opts.tamper) {
    // 篡改单被中继接受 = 零容忍（阶段 3 后 side 在签名内，改写副本
    // 验签必失败，中继应在入库处拒绝）
    if (res.ok) {
      ledger.trip('tamperAccepted', `篡改单被中继接受（digest=${rec.digest}）`, {
        chainId: ctx.chainId,
        digest: rec.digest,
      })
    }
    if (res.unknown) {
      // 发单超时：拒绝与否无从确认，记无结论失败行（不冒充已拒绝）
      ledger.fail({
        ts: Date.now(),
        chainId: ctx.chainId,
        kind: 'tamper-inject-unknown',
        detail: `篡改注入发单超时，中继拒绝状态未知：${res.error ?? ''}`,
        digest: rec.digest,
      })
    } else {
      log(`chain ${ctx.chainId} 篡改注入被中继拒绝（status=${res.status}），符合预期`)
    }
  } else if (res.unknown) {
    // 第 48 轮：发单超时 = 接受状态未知，不按投递失败下结论；
    // 在场探针会连这批单一起查簿（在簿 = 已接单，不在簿 = 无结论）。
    ledger.line({
      kind: 'relay-acceptance-unknown',
      ts: Date.now(),
      chainId: ctx.chainId,
      digest: rec.digest,
      orderId: rec.orderId,
      error: res.error,
    })
    log(`chain ${ctx.chainId} 订单投递中继超时，接受状态未知（digest=${rec.digest}），待在场探针认账`)
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

/**
 * 在场探针：中继已接单的订单必须出现在中继簿里（按 orderId 查），
 * 否则按订单丢失计。第 48 轮：发单超时「接受状态未知」的单也一并
 * 查——在簿则认账为已接单（补记 relayAccepted 并留痕）；到点仍不
 * 在簿只记无结论（中继可能压根没收到这张单），不按订单丢失 trip。
 */
async function probePresence(
  ledger: Stage4Ledger,
  ctx: ChainCtx,
  pair: string,
  gens: GeneratedOrder[],
): Promise<void> {
  const want = gens.filter((g) => {
    const rec = ledger.posted.get(g.digest.toLowerCase())
    return rec && (rec.relayOk || rec.relayUnknown) && !rec.tampered
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
    // 接受未知的单在簿出现 = 中继其实接了单，当场认账（只认一次）
    for (const g of want) {
      const rec = ledger.posted.get(g.digest.toLowerCase())
      if (rec?.relayUnknown && ids.has(String(g.body.orderId))) {
        rec.relayUnknown = undefined
        rec.relayOk = true
        ledger.counts[ctx.chainId].relayAccepted += 1
        ledger.line({
          kind: 'relay-unknown-resolved',
          ts: Date.now(),
          chainId: ctx.chainId,
          digest: rec.digest,
          orderId: rec.orderId,
          result: 'present-in-book',
        })
        log(`chain ${ctx.chainId} 接受未知的订单已在中继簿认账（orderId=${rec.orderId}）`)
      }
    }
    missing = want.filter((g) => !ids.has(String(g.body.orderId)))
    if (missing.length > 0) await sleep(10_000)
  }
  for (const g of missing) {
    const rec = ledger.posted.get(g.digest.toLowerCase())
    if (rec?.relayUnknown) {
      // 到点仍不在簿且接受状态未知：中继可能没收到，不下丢失结论
      ledger.line({
        kind: 'probe-inconclusive',
        ts: Date.now(),
        chainId: ctx.chainId,
        pair,
        reason: 'relay-acceptance-unknown-not-in-book',
        digest: rec.digest,
        orderId: rec.orderId,
      })
      log(`chain ${ctx.chainId} 接受未知的订单不在中继簿（无结论，不按丢失计）：orderId=${rec.orderId}`)
      continue
    }
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
    const outcome = await traceCall('match.execute', ctx.chainId, () =>
      executeFrontendMatch(
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
      ),
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

/**
 * 回执事件多重集是否覆盖扫描发现的事件（第 52 轮 B1 对账）：键为
 * (maker, taker, amountIn, amountOut)——扫描侧（getLogs 全量日志流）
 * 与回执侧（单 tx 完整日志）是同一批链上事件的两种读法，同一笔交
 * 易里扫描见到的每一笔成交都必须能在回执里找到一模一样的一笔
 * （计数含重复：同参数两笔要各占一个名额）。回执是该 tx 的完整
 * 日志集，正常情况下恒覆盖；不覆盖 = 两次 RPC 读不一致（或链重
 * 组），按未验真处理，不认回。
 */
function tradeEventsCover(
  receiptEvents: ParsedTradeEvent[],
  scanEvents: ParsedTradeEvent[],
): boolean {
  const key = (e: ParsedTradeEvent) =>
    `${lc(e.maker)}|${lc(e.taker)}|${e.amountIn}|${e.amountOut}`
  const counts = new Map<string, number>()
  for (const e of receiptEvents) counts.set(key(e), (counts.get(key(e)) ?? 0) + 1)
  for (const e of scanEvents) {
    const k = key(e)
    const left = counts.get(k) ?? 0
    if (left <= 0) return false
    counts.set(k, left - 1)
  }
  return true
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

const RECEIPT_GRACE_MS = 120_000
const RECEIPT_POLL_MS = 5_000

/**
 * 回执宽限读取（第 45 轮 B4）：刚提交的结算回执可能短暂查不到，
 * 在宽限内轮询；RPC 瞬时报错也不下结论、继续轮询到宽限届满。
 * 返回 null = 宽限内始终没拿到回执——查不到与读不到都归「结算
 * 状态未知」，由调用方按失败关闭处理（不再像旧口径那样把探针
 * 异常降级成普通 cycle-error 带着未知状态继续跑）。
 */
async function fetchReceiptWithGrace(
  ctx: ChainCtx,
  txHash: string,
): Promise<ethers.TransactionReceipt | null> {
  const deadline = Date.now() + RECEIPT_GRACE_MS
  for (;;) {
    try {
      const receipt = await traceCall('rpc.getTransactionReceipt', ctx.chainId, () =>
        ctx.provider.getTransactionReceipt(txHash),
      )
      if (receipt) return receipt
    } catch {
      // RPC 瞬时错误不下结论，宽限内继续轮询
    }
    if (Date.now() >= deadline) return null
    await sleep(RECEIPT_POLL_MS)
  }
}

/**
 * taker 已成交量读取（主路径与恢复/对账路径共用，第 48 轮 P2）：
 * 失败重试共 3 次（间隔同回执轮询），仍失败返回 null——调用方按
 * 「结算状态未知」失败关闭，不许拿缺失读数当 0 或跳过核对。
 */
async function readFilledInWithRetry(
  ctx: ChainCtx,
  digest: string,
): Promise<bigint | null> {
  for (let attemptNo = 0; attemptNo < 3; attemptNo++) {
    try {
      return (await traceCall('rpc.orderFilledIn', ctx.chainId, () =>
        ctx.settlementRead.orderFilledIn(digest),
      )) as bigint
    } catch {
      if (attemptNo < 2) await sleep(RECEIPT_POLL_MS)
    }
  }
  return null
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
  const takerData = buildSignedOrderData(asRaw(takerGen), ctx.chainId)
  // 第 48 轮 P1-1：txHash 一到手先落恢复账本，再去探回执——旧顺序
  // 先等回执宽限（≤120s）才 notePending，进程若死在宽限窗口里，
  // 这笔已提交结算就从记账里凭空消失。记账在前、探针在后；进程
  // 中途死掉，下次启动/对账先复查这笔，不丢账。全部核完才在下方
  // 「先写 probe 记录、再 confirmPending 清除」（P2 记账顺序）。
  ledger.notePending({
    txHash,
    chainId: ctx.chainId,
    pair,
    takerDigest: takerGen.digest.toLowerCase(),
    legs: attempt.legsKept,
    takerAmountIn: takerData ? takerData.amountIn : null,
    notedAt: Date.now(),
  })
  if (!takerData) {
    ledger.trip(
      'invalidSettle',
      `结算状态未知：taker 订单签名重构失败，无签名量可核对超量（失败关闭）tx=${txHash}`,
      { chainId: ctx.chainId, txHash, digest: takerGen.digest },
    )
  }
  const receipt = await fetchReceiptWithGrace(ctx, txHash)
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
    ledger.trip(
      'invalidSettle',
      `结算状态未知：宽限 ${RECEIPT_GRACE_MS / 1000}s 内未取得回执（B4 失败关闭）tx=${txHash}`,
      { chainId: ctx.chainId, txHash },
    )
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
  // B4：读数失败重试 3 次（readFilledInWithRetry，与恢复路径同
  // 一助手），仍失败 = 结算状态未知 → 失败关闭，不降级放行
  const filledIn = await readFilledInWithRetry(ctx, takerGen.digest)
  if (filledIn === null) {
    ledger.trip(
      'invalidSettle',
      `结算状态未知：taker 已成交量读取重试后仍失败（B4 失败关闭）tx=${txHash}`,
      { chainId: ctx.chainId, txHash, digest: takerGen.digest },
    )
  }
  if (filledIn! > BigInt(takerData!.amountIn)) {
    ledger.trip(
      'invalidSettle',
      `taker 已成交量 ${filledIn} 超签名量 ${takerData!.amountIn}：digest=${takerGen.digest}`,
      { chainId: ctx.chainId, txHash, digest: takerGen.digest },
    )
  }
  // 第 48 轮 P2 记账顺序：先落 probe 确认记录，再清恢复账本——
  // 进程死在两者之间时，遗留 pending 会在下次启动被幂等复查
  // （见 recoverPendingSettlements 的 already-confirmed 合并），
  // 反之先清账本后写记录，死掉就两头都丢。
  ledger.line({ kind: 'probe', ts: Date.now(), ...rec })
  ledger.confirmPending(txHash)
}

/**
 * 待确认结算的单笔链上确认（启动恢复与超时对账共用，第 48 轮）：
 * 口径与 probeSettlement 完全一致——回执 status=1、成交事件数 ==
 * 腿数、taker 已成交量不超签名量，均以链上为准。任一项状态未知
 * 或不符 → 按 B4 失败关闭 trip。第 48 轮 P2 补齐：已成交量读取
 * 与主路径同等 3 次重试；takerAmountIn 缺失（记账时签名重构曾
 * 失败）不得再当「可跳过核对」——无签名量就无法排除超量成交，
 * 按结算状态未知失败关闭。
 */
async function confirmPendingEntry(
  ledger: Stage4Ledger,
  ctx: ChainCtx,
  entry: PendingSettlement,
  origin: string,
): Promise<SettlementRecord> {
  const receipt = await fetchReceiptWithGrace(ctx, entry.txHash)
  if (!receipt) {
    ledger.trip(
      'invalidSettle',
      `${origin}：结算状态未知，宽限 ${RECEIPT_GRACE_MS / 1000}s 内未取得回执（B4 失败关闭）tx=${entry.txHash}`,
      { chainId: entry.chainId, txHash: entry.txHash },
    )
  }
  if (receipt!.status !== 1) {
    ledger.trip('invalidSettle', `${origin}：结算 tx 回执 status=${receipt!.status} tx=${entry.txHash}`, {
      chainId: entry.chainId,
      txHash: entry.txHash,
    })
  }
  const events = parseTradeEvents(receipt!, ctx.chainCfg.contracts.settlement)
  if (events.length !== entry.legs) {
    ledger.trip(
      'invalidSettle',
      `${origin}：成交事件数 ${events.length} != 撮合腿数 ${entry.legs} tx=${entry.txHash}`,
      { chainId: entry.chainId, txHash: entry.txHash },
    )
  }
  if (entry.takerAmountIn === null) {
    ledger.trip(
      'invalidSettle',
      `${origin}：结算状态未知，待确认记录缺 taker 签名量，无法核对超量成交（失败关闭）tx=${entry.txHash}`,
      { chainId: entry.chainId, txHash: entry.txHash, digest: entry.takerDigest },
    )
  }
  const filledIn = await readFilledInWithRetry(ctx, entry.takerDigest)
  if (filledIn === null) {
    ledger.trip(
      'invalidSettle',
      `${origin}：结算状态未知，taker 已成交量读取重试后仍失败（B4 失败关闭）tx=${entry.txHash}`,
      { chainId: entry.chainId, txHash: entry.txHash, digest: entry.takerDigest },
    )
  }
  if (filledIn! > BigInt(entry.takerAmountIn!)) {
    ledger.trip(
      'invalidSettle',
      `${origin}：taker 已成交量 ${filledIn} 超签名量 ${entry.takerAmountIn} tx=${entry.txHash}`,
      { chainId: entry.chainId, txHash: entry.txHash, digest: entry.takerDigest },
    )
  }
  return {
    txHash: entry.txHash,
    chainId: entry.chainId,
    pair: entry.pair,
    takerDigest: entry.takerDigest,
    legs: entry.legs,
    settledAt: entry.notedAt,
    events,
    probe: { receipt: 'ok', eventsMatch: 'ok', indexer: 'pending' },
  }
}

/**
 * B5 启动恢复：进新周期前先复查上次进程遗留的待确认结算，全部
 * 确认完才开跑（单笔确认走 confirmPendingEntry，口径见其注释）。
 * 第 48 轮 P2：本轮 settlements 里已有同 txHash 的确认记录时按
 * 幂等合并处理（只清账本、不重复计数）；确认记账顺序定版为
 * 先写 probe/恢复记录、再清 pending——死在中间只会留下一笔可
 * 幂等复查的遗留，不会两头都丢。恢复账本损坏在此抛
 * PendingLedgerCorruptError，由启动路径失败关闭（P1-3）。
 * 第 50 轮 P2：「已有确认记录」的判重补上落盘口径——除内存
 * settlements 外再查 metrics 里既有的 probe 记录行（hasProbeRecord），
 * 进程死在「probe 行已写、pending 未清」时重启不再重复确认、
 * 不再重复追加 probe 行。
 */
export async function recoverPendingSettlements(
  ledger: Stage4Ledger,
  ctxs: Map<number, ChainCtx>,
): Promise<void> {
  const pending = ledger.loadPending()
  if (pending.length === 0) return
  log(`启动恢复：复查 ${pending.length} 笔遗留待确认结算（B5 恢复账本）`)
  for (const entry of pending) {
    const ctx = ctxs.get(entry.chainId)
    if (!ctx) {
      ledger.trip('invalidSettle', `恢复账本含未知链结算（B4 失败关闭）tx=${entry.txHash} chainId=${entry.chainId}`, {
        chainId: entry.chainId,
        txHash: entry.txHash,
      })
    }
    if (
      ledger.settlements.some((s) => lc(s.txHash) === lc(entry.txHash)) ||
      ledger.hasProbeRecord(entry.txHash)
    ) {
      ledger.line({
        kind: 'recovery',
        ts: Date.now(),
        chainId: entry.chainId,
        txHash: entry.txHash,
        result: 'already-confirmed',
      })
      ledger.confirmPending(entry.txHash)
      continue
    }
    const rec = await confirmPendingEntry(ledger, ctx!, entry, '恢复复查')
    ledger.settlements.push(rec)
    ledger.counts[entry.chainId].settlements += 1
    ledger.counts[entry.chainId].legs += entry.legs
    ledger.line({ kind: 'probe', ts: Date.now(), ...rec })
    ledger.line({
      kind: 'recovery',
      ts: Date.now(),
      chainId: entry.chainId,
      txHash: entry.txHash,
      result: 'confirmed',
    })
    ledger.confirmPending(entry.txHash)
    log(`恢复确认结算 tx=${entry.txHash}（chain ${entry.chainId}，${entry.legs} 腿）`)
  }
}

/**
 * 第 48 轮 P1-2 超时对账：某链周期被 420s 硬超时打断后，被放弃的
 * 在飞撮合可能迟到广播上链而运行器毫无记录。本函数在该链提交
 * 任何新单之前先把账对清：① 内存恢复账本里本链的待确认结算逐
 * 笔链上确认（confirmPendingEntry，口径同启动恢复）；② 从超时
 * 周期开始的区块起扫描 Settlement 成交事件，把涉及本运行器
 * maker/taker 的未知 txHash 认回来记账计数。扫描/确认失败向上
 * 抛（调用方保隔离状态、本轮不对该链提新单）；确认中发现不符
 * 按失败关闭 trip。对账能认回的是「已上链的成交」；迟到的单若
 * 还没成交，它仍在 ledger.posted 与中继簿里，后续周期自然覆盖。
 * 第 50 轮 P1：事件扫描发现的迟到成交若回执在宽限内不可验真
 * （取不到或 status≠1），对账不得报 complete——留痕后抛错保
 * 隔离、下周期重试，堵住「未验真的迟到成交被对完账放行」的洞。
 */
export async function reconcileAfterTimeout(
  ledger: Stage4Ledger,
  cfg: Stage4Config,
  ctx: ChainCtx,
  fromBlock: number,
): Promise<void> {
  void cfg
  // ① 本链遗留待确认结算先确认完（第 50 轮：判重同恢复路径，
  // 内存 settlements + metrics 落盘 probe 记录双查，不重复记账）
  for (const entry of ledger.pendingEntries()) {
    if (entry.chainId !== ctx.chainId) continue
    if (
      ledger.settlements.some((s) => lc(s.txHash) === lc(entry.txHash)) ||
      ledger.hasProbeRecord(entry.txHash)
    ) {
      ledger.confirmPending(entry.txHash)
      continue
    }
    const rec = await confirmPendingEntry(ledger, ctx, entry, '超时对账')
    ledger.settlements.push(rec)
    ledger.counts[entry.chainId].settlements += 1
    ledger.counts[entry.chainId].legs += entry.legs
    ledger.line({ kind: 'probe', ts: Date.now(), ...rec })
    ledger.line({
      kind: 'reconcile',
      ts: Date.now(),
      chainId: entry.chainId,
      txHash: entry.txHash,
      result: 'pending-confirmed',
    })
    ledger.confirmPending(entry.txHash)
  }
  // ② 事件扫描认回迟到广播的成交（fromBlock 为 0/过旧时收敛到最近 2000 块）
  const latest = await ctx.provider.getBlockNumber()
  const scanFrom = fromBlock > 0 && latest - fromBlock <= 2000 ? fromBlock : Math.max(0, latest - 2000)
  const logs = await traceCall('chain.getLogs', ctx.chainId, () =>
    ctx.provider.getLogs({
      address: ctx.chainCfg.contracts.settlement,
      fromBlock: scanFrom,
      toBlock: 'latest',
    }),
  )
  const ours = new Set([lc(ctx.maker.address), lc(ctx.taker.address)])
  const seenTx = new Set(ledger.settlements.map((s) => lc(s.txHash)))
  const lateTxHashes: string[] = []
  // 第 52 轮 B1：扫描侧每笔成交事件按 tx 留存（maker/taker/双量），
  // 供下方与回执解析事件做多重集对账——只记 txHash 时回执那边
  // 「status=1 且事件对不上」无从发现。
  const scanEventsByTx = new Map<string, ParsedTradeEvent[]>()
  for (const lg of logs) {
    try {
      const parsed = settleIface.parseLog({ topics: [...lg.topics], data: lg.data })
      if (
        parsed &&
        (parsed.name === 'TradeSettled' || parsed.name === 'TradeSettledWithGasReimburse') &&
        (ours.has(lc(String(parsed.args.maker))) || ours.has(lc(String(parsed.args.taker))))
      ) {
        const key = lc(lg.transactionHash)
        if (!seenTx.has(key)) {
          seenTx.add(key)
          lateTxHashes.push(lg.transactionHash)
        }
        const ev: ParsedTradeEvent = {
          maker: String(parsed.args.maker),
          taker: String(parsed.args.taker),
          amountIn: BigInt(parsed.args.amountIn).toString(),
          amountOut: BigInt(parsed.args.amountOut).toString(),
        }
        const arr = scanEventsByTx.get(key)
        if (arr) arr.push(ev)
        else scanEventsByTx.set(key, [ev])
      }
    } catch {
      // 非 Settlement 成交事件，忽略（与 parseTradeEvents 同口径）
    }
  }
  let lateRecovered = 0
  const unverifiedLate: string[] = []
  for (const txHash of lateTxHashes) {
    const receipt = await fetchReceiptWithGrace(ctx, txHash)
    if (!receipt || receipt.status !== 1) {
      ledger.line({
        kind: 'reconcile',
        ts: Date.now(),
        chainId: ctx.chainId,
        txHash,
        result: 'late-tx-unverified',
        detail: `迟到成交事件的回执${receipt ? ` status=${receipt.status}` : '宽限内未取得'}，只留痕不计数`,
      })
      unverifiedLate.push(txHash)
      continue
    }
    const events = parseTradeEvents(receipt, ctx.chainCfg.contracts.settlement)
    // 第 52 轮 B1：status=1 只说明交易成功，不等于扫描发现的成交
    // 已在回执里验真——回执解析为空、或解析事件与扫描发现的事件
    // 多重集对不上（RPC 两次读取不一致/链重组），都按未验真处理：
    // 留痕并进 unverifiedLate（下方 incomplete 抛错保隔离），不计数。
    const scanEvents = scanEventsByTx.get(lc(txHash)) ?? []
    if (events.length === 0 || !tradeEventsCover(events, scanEvents)) {
      ledger.line({
        kind: 'reconcile',
        ts: Date.now(),
        chainId: ctx.chainId,
        txHash,
        result: 'late-tx-unverified',
        detail: `迟到成交回执 status=1 但事件对账不通过（回执解析 ${events.length} 笔、扫描发现 ${scanEvents.length} 笔，多重集未覆盖扫描发现），只留痕不计数`,
      })
      unverifiedLate.push(txHash)
      continue
    }
    ledger.counts[ctx.chainId].settlements += 1
    ledger.counts[ctx.chainId].legs += events.length
    lateRecovered += 1
    ledger.line({
      kind: 'reconcile',
      ts: Date.now(),
      chainId: ctx.chainId,
      txHash,
      result: 'late-settlement-recovered',
      legs: events.length,
      events,
    })
    log(`超时对账认回迟到成交 tx=${txHash}（chain ${ctx.chainId}，${events.length} 腿）`)
  }
  // 第 50 轮 P1：有迟到成交没验真回执时，对账不完整——绝不报
  // complete。旧实现记一行 late-tx-unverified 就 continue、最后照
  // 报 complete，调用方据此删隔离：一笔只靠事件扫描发现、回执当
  // 时不可见的迟到成交就被「对完账」放行，再无人复查。现改为
  // 留痕后抛错（普通错误，非零容忍 trip）：调用方保隔离、本轮
  // 不对本链提新单，下一周期重新对账——回执届时可见即认回，
  // 持续不可见则隔离持续保留（失败关闭）。自家已 notePending 的
  // 结算不走这条：它们在上方 ① 经 confirmPendingEntry 确认，
  // 回执不可见本就 trip 失败关闭，语义不变。
  if (unverifiedLate.length > 0) {
    ledger.line({
      kind: 'reconcile',
      ts: Date.now(),
      chainId: ctx.chainId,
      result: 'incomplete-unverified-late-tx',
      fromBlock: scanFrom,
      unverifiedLate,
      detail: '存在回执未验真的迟到成交，对账不完整：不报 complete、保隔离、下周期重试（失败关闭）',
    })
    throw new Error(
      `超时对账未完成：${unverifiedLate.length} 笔迟到成交回执未验真（${unverifiedLate.join(', ')}），隔离保留`,
    )
  }
  ledger.line({
    kind: 'reconcile',
    ts: Date.now(),
    chainId: ctx.chainId,
    result: 'complete',
    fromBlock: scanFrom,
    lateRecovered,
  })
}

/**
 * 索引器探针复查：pending 的 settlement 反复查到收录且字段一致为止。
 * 按 Ren 2026-11-09 新口径，索引器只是展示缓存：查询失败记无结论
 * 观察项、超宽限未收录记 lagging 观察项、收录后字段不符记
 * mismatch-observed 观察项——三种情况都不停机，后续周期继续复查；
 * 成交正确性已由 probeSettlement 按链上回执+事件核完，不依赖索引器。
 */
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
        const chunk = await traceCall('indexer.fetchTrades', rec.chainId, () =>
          fetchIndexerTrades(
            rec.chainId,
            rec.pair,
            50,
            indexerFetchFn,
            cfg.indexerUrl,
            page * 50,
          ),
        )
        rows.push(...chunk)
        if (chunk.length < 50) break
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      ledger.line({
        kind: 'probe-inconclusive',
        ts: Date.now(),
        chainId: rec.chainId,
        source: 'indexer',
        txHash: rec.txHash,
        reason,
      })
      log(`索引器探针查询失败（无结论观察项，稍后重试）：${reason}`)
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
        // 收录了但字段对不上：观察项留痕（fail 行 + probe-indexer 行），
        // 不停机——账本在链上，索引器只是展示缓存（Ren 09:13 口径）。
        rec.probe.indexer = 'mismatch'
        ledger.line({ kind: 'probe-indexer', ts: Date.now(), txHash: rec.txHash, chainId: rec.chainId, result: 'mismatch-observed', want, got })
        ledger.fail({
          ts: Date.now(),
          chainId: rec.chainId,
          kind: 'indexer-mismatch-observed',
          detail: `索引器成交与回执事件多重集不符（观察项，不停机）tx=${rec.txHash} want=${JSON.stringify(want)} got=${JSON.stringify(got)}`,
          txHash: rec.txHash,
        })
      }
      continue
    }
    if (Date.now() - rec.settledAt > cfg.indexerGraceSec * 1000 && !rec.lagReported) {
      // 超宽限仍未收录：记一次 lagging 观察项后保持 pending，后续
      // 周期继续复查（阶段 4 两次实测均为免费层收录滞后 18–30+ 分钟，
      // 最终字段全对——滞后是展示时效问题，不是数据不一致）。
      rec.lagReported = true
      ledger.line({
        kind: 'probe-indexer',
        ts: Date.now(),
        txHash: rec.txHash,
        chainId: rec.chainId,
        result: 'lagging',
        graceSec: cfg.indexerGraceSec,
      })
      log(`索引器滞后观察：tx=${rec.txHash} 超宽限 ${cfg.indexerGraceSec}s 仍未收录（观察项，不停机，继续复查）`)
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
    const round = await traceCall('dualread.round', chk.chainId, () =>
      runDualReadRound(
        {
          mode: 'shadow',
          nodeAdapter: ctx.nodeAdapter,
          relayAdapter: ctx.relayAdapter,
          chainReader: ctx.chainReader,
        },
        chk.chainId,
        [chk.pair],
      ),
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
  const { generated, skipped } = await traceCall('gen.generateBatch', ctx.chainId, () =>
    generateBatch(
      ctx.chainId,
      [ctx.maker, ctx.taker],
      [{ role: 'maker', pair, side: 'sell', amount: '0.0005', price: PRICE }],
      ctx.nonceCursor,
    ),
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
  await traceCall('tx.lockForOrder', ctx.chainId, async () => {
    const lockTx = await vaultWrite.lockForOrder(contractOrder, String(gen.body.signature))
    await lockTx.wait()
  })
  const lock = await traceCall('rpc.orderLocks', ctx.chainId, () =>
    ctx.vaultRead.orderLocks(gen.digest),
  )
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
  await traceCall('tx.releaseOrderLock', ctx.chainId, async () => {
    const relTx = await vaultWrite.releaseOrderLock(gen.digest)
    await relTx.wait()
  })
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
    const outcome = await traceCall('match.execute', ctx.chainId, () =>
      executeFrontendMatch(
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
      ),
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
  await traceCall('tx.lockForOrder', ctx.chainId, async () => {
    const lockTx = await vaultWrite.lockForOrder(
      orderDataToContractOrder(data),
      String(gen.body.signature),
    )
    await lockTx.wait()
  })
  const digest = gen.digest
  const makerData = data
  const makerSig = String(gen.body.signature)
  pendingActions.push({
    dueAt: (Number(gen.body.expiresAt) + 30) * 1000,
    label: `attribution:${ctx.chainId}:${digest.slice(0, 10)}`,
    run: async () => {
      const steps: Record<string, string> = {}
      try {
        const relReceipt = await traceCall('tx.releaseExpiredOrderLock', ctx.chainId, async () => {
          const relTx = await vaultWrite.releaseExpiredOrderLock(digest)
          return relTx.wait()
        })
        steps.releaseExpired = `tx=${relReceipt?.hash} status=${relReceipt?.status}`
      } catch (e) {
        steps.releaseExpired = `error: ${e instanceof Error ? e.message.slice(0, 140) : String(e)}`
      }
      // 组 taker 单 + Fill（fills.ts 同口径内联，与 stage3-e2e 驱动同法）
      const { generated } = await traceCall('gen.generateBatch', ctx.chainId, () =>
        generateBatch(
          ctx.chainId,
          [ctx.maker, ctx.taker],
          [{ role: 'taker', pair, side: 'buy', amount: '0.0005', price: PRICE }],
          ctx.nonceCursor,
        ),
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
        await traceCall('tx.settleTradeStatic', ctx.chainId, () =>
          settleTaker.settleTrade.staticCall(fill),
        )
        steps.staticCall = 'UNEXPECTED-SUCCESS'
      } catch (e) {
        steps.staticCall = `reverted: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`
      }
      let failGasUsed: bigint | null = null
      try {
        const rc = await traceCall('tx.settleTrade', ctx.chainId, async () => {
          const tx = await settleTaker.settleTrade(fill, { gasLimit: 1_500_000n })
          return tx.wait()
        })
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
          const crc = await traceCall('tx.chargeFailedSettlement', ctx.chainId, async () => {
            const chargeTx = await settleOwner.chargeFailedSettlement(
              { order: orderDataToContractOrder(makerData), signature: makerSig },
              FAIL_ORDER_EXPIRED,
              failGasUsed,
            )
            return chargeTx.wait()
          })
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
  const pendingPath = join(cfg.outDir, 'stage4-pending-settlements.json')
  const windowStart = Date.now()
  const ledger = new Stage4Ledger(
    metricsPath,
    statePath,
    pendingPath,
    windowStart,
    windowStart + cfg.maxHours * 3600_000,
  )
  setTraceSink((l) => ledger.line(l))
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
  // B5：先复查遗留待确认结算，确认完才进新周期（失败关闭在此拦截）
  try {
    await recoverPendingSettlements(ledger, ctxs)
  } catch (e) {
    if (e instanceof ZeroToleranceError) {
      log(`启动恢复触发失败关闭，停跑保全证据：${e.message}`)
      ledger.saveState('zero-tolerance-triggered')
      return 3
    }
    if (e instanceof PendingLedgerCorruptError) {
      // 第 48 轮 P1-3：账本损坏 = 失败关闭（属零容忍类），与
      // ZeroToleranceError 同路收尾：保全证据、状态标 triggered。
      log(`启动恢复失败关闭（恢复账本损坏），停跑保全证据：${e.message}`)
      ledger.zero.triggered = true
      ledger.zero.detail = e.message
      ledger.saveState('zero-tolerance-triggered')
      return 3
    }
    throw e
  }
  // 第 48 轮 P1-2：被周期超时打断的链先进隔离——下一周期前先对账
  // （reconcileAfterTimeout），对完账才许对该链提交新单。
  const quarantine = new Map<number, { fromBlock: number; since: number }>()
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
        const ctx = ctxs.get(chainId)!
        const q = quarantine.get(chainId)
        if (q) {
          // 隔离中：先对账，对完账才恢复本链周期；对账失败保隔离、
          // 本轮跳过本链（不提新单），下一周期继续对账。
          try {
            await withTimeout(
              reconcileAfterTimeout(ledger, cfg, ctx, q.fromBlock),
              RECHECK_TIMEOUT_MS,
              `chain ${chainId} 超时对账`,
            )
            quarantine.delete(chainId)
            ledger.line({
              kind: 'quarantine-cleared',
              ts: Date.now(),
              chainId,
              fromBlock: q.fromBlock,
              quarantinedMs: Date.now() - q.since,
            })
            log(`chain ${chainId} 超时对账完成，隔离解除`)
          } catch (e) {
            if (e instanceof ZeroToleranceError) throw e
            ledger.fail({
              ts: Date.now(),
              chainId,
              kind: 'reconcile-error',
              detail: `超时对账失败（保隔离，本轮不对本链提新单）：${e instanceof Error ? e.message.slice(0, 160) : String(e)}`,
            })
            continue
          }
        }
        let startBlock = 0
        try {
          startBlock = await ctx.provider.getBlockNumber()
        } catch {
          startBlock = 0 // 取不到时对账侧会收敛扫描范围（最近 2000 块）
        }
        try {
          await withTimeout(
            runChainCycle(ledger, cfg, ctx, cycle),
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
          if (e instanceof CycleTimeoutError) {
            // 硬超时取消不了已在飞的撮合：迟到广播可能随后上链。
            // 本链进隔离，下一周期先对账认回，再许提新单。
            quarantine.set(chainId, { fromBlock: startBlock, since: Date.now() })
            ledger.line({
              kind: 'quarantine',
              ts: Date.now(),
              chainId,
              fromBlock: startBlock,
              reason: e.message,
            })
            log(`chain ${chainId} 周期超时，进隔离状态：下一周期前先对账`)
          }
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
  // 收尾复查：给索引器 pending 探针最后一次机会（滞后只记观察项，不停机）
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
