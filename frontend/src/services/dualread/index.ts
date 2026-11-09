/**
 * 订单簿读取管线入口：第 34 轮建立时为「节点 + 中继」双读影子对比，
 * 第 51 轮（无节点阶段 5 节点退役）改为中继单源——拉中继簿 → 本地
 * 重构订单并重算 digest → 本地验签（失败补链上 ERC-1271）→ 一次链上
 * 批量快照 → 状态机评估 → 合并出可成交集合。校验语义与双读时代逐条
 * 相同（见 evaluate.ts 状态机），只是候选只剩中继一份副本：同 digest
 * 的多源冲突判定随之退役（单源无从冲突），影子指标（metrics.ts）删除。
 *
 * 目录名 dualread 与 runDualReadRound 兼容别名保留，是为了不打断已
 * 关闭的验收工具（scripts/stage4 阶段 4 运行器）对本路径的 import；
 * 新代码请用 runBookRound。
 */
import { createRelayBookAdapter, type BookAdapter } from './adapters'
import {
  createChainStateReader,
  createViemChainTransport,
  type ChainStateReader,
  type ChainStateRequest,
} from './chainState'
import {
  mergeBooks,
  prepareCandidates,
  type VerifyFn,
} from './evaluate'
import type { MergedView, SourceBook } from './types'

export * from './types'
export { buildSignedOrderData, computeOrderDigest, hashOrderWithDomain } from './digest'
export {
  createRelayBookAdapter,
  toRawOrder,
  sortBookSide,
  normalizeBookRows,
  requireBookSides,
  RELAY_BOOK_SIDE_CAP,
  RELAY_BOOK_TIMEOUT_MS,
} from './adapters'
export type { FetchFn, RelayBookAdapterOptions } from './adapters'
export {
  createChainStateReader,
  createViemChainTransport,
  assembleChainState,
  buildStateCalls,
} from './chainState'
export type { ChainStateReader, ChainStateRequest } from './chainState'
export {
  prepareCandidates,
  evaluateCandidate,
  mergeBooks,
  deriveSideFromLock,
  defaultVerifyFn,
} from './evaluate'
export type { EvaluateOptions, PreparedCandidate, PrepareResult, VerifyFn } from './evaluate'
export { CHAIN_UNPROVEN, SIDE_PROOF_AVAILABLE, SIDE_UNPROVABLE } from './protocol'

/** 一轮读取的注入点（产品缺省全部骑生产实现；测试/工具可注入） */
export interface BookReadDeps {
  relayAdapter?: BookAdapter
  chainReader?: ChainStateReader
  verify?: VerifyFn
}

/** 一轮读取的结果：按交易对的合并视图 + 原始簿快照 + 逐面错误（降级不抛错） */
export interface BookRound {
  chainId: number
  views: MergedView[]
  books: Array<{ pair: string; relay: SourceBook | null }>
  chainOk: boolean
  chainStale: boolean
  errors: Partial<Record<'relay' | 'rpc', string>>
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * 执行一轮中继单源读取：每个交易对拉一次中继簿；跨全部交易对的候选
 * 只请求一次链上批量快照（本地验签全灭的订单才补 ERC-1271 链上验签
 * 材料）；中继挂了/RPC 挂了都降级为「该面为空 + errors 记录」，不整
 * 体抛错——与双读时代的降级口径一致。
 */
export async function runBookRound(
  deps: BookReadDeps = {},
  chainId: number,
  pairs: readonly string[],
): Promise<BookRound> {
  const relayAdapter = deps.relayAdapter ?? createRelayBookAdapter()
  const chainReader =
    deps.chainReader ?? createChainStateReader(createViemChainTransport())
  const errors: BookRound['errors'] = {}

  // 1) 中继拉取（逐对；失败只降级该对的簿，不拖垮整轮）
  const books: BookRound['books'] = []
  for (const pair of pairs) {
    let relay: SourceBook | null = null
    try {
      relay = await relayAdapter.fetchBook(chainId, pair)
    } catch (e) {
      errors.relay = errMsg(e)
    }
    books.push({ pair, relay })
  }

  // 2) 逐对重构 + 本地验签；汇总链上请求（同 digest 跨对去重；
  //    本地未过的补链上验签材料）
  const preparedByPair = new Map<string, Awaited<ReturnType<typeof prepareCandidates>>>()
  const chainRequests: ChainStateRequest[] = []
  const seenDigests = new Set<string>()
  for (const { pair, relay } of books) {
    const prepared = await prepareCandidates(chainId, [relay], deps.verify)
    preparedByPair.set(pair, prepared)
    for (const cand of prepared.candidates) {
      const dkey = cand.identity.digest.toLowerCase()
      if (seenDigests.has(dkey)) continue
      seenDigests.add(dkey)
      const firstRaw = cand.raws.relay
      chainRequests.push({
        digest: cand.identity.digest,
        userAddress: cand.data.userAddress,
        nonce: cand.data.nonce,
        verifyOrder: cand.anyLocalValid
          ? undefined
          : firstRaw
            ? { data: cand.data, signature: firstRaw.signature }
            : undefined,
      })
    }
  }

  // 3) 一次链上批量快照（全交易对共享；失败 → chain=null，全单 UNKNOWN）
  let chain: Awaited<ReturnType<ChainStateReader['snapshot']>> | null = null
  try {
    chain = await chainReader.snapshot(chainId, chainRequests)
  } catch (e) {
    errors.rpc = errMsg(e)
  }
  const chainOk = Boolean(chain && !chain.stale)

  // 4) 逐对合并评估
  const views = books.map(({ pair }) =>
    mergeBooks(chainId, pair, preparedByPair.get(pair)!, chain),
  )
  return {
    chainId,
    views,
    books,
    chainOk,
    chainStale: Boolean(chain?.stale),
    errors,
  }
}

/**
 * 兼容别名（第 51 轮）：已关闭的阶段 4 验收运行器（scripts/stage4）仍
 * 按旧名 runDualReadRound 调用并传 { mode, nodeAdapter, observer } 形
 * 状的 deps——这些字段一律忽略（节点源与影子指标已退役），返回值在
 * 单源轮结果上补齐旧形状（node 恒 null、metrics 恒 null、mode 恒
 * 'active' 表示中继即正式源）。新代码不要再用本别名。
 * 注：soak 遗留工具还从本模块 import ShadowObserver——soak 已于
 * 2026-11-08 经 Ren 豁免停用（3A 免检），其引用随 metrics.ts 删除而
 * 失效，属退役工具的登记影响，不在本轮修复面内。
 */
export interface DualReadDeps extends BookReadDeps {
  mode?: unknown
  nodeAdapter?: unknown
  observer?: unknown
}

export interface DualReadRound extends Omit<BookRound, 'books' | 'errors'> {
  mode: 'active'
  books: Array<{ pair: string; node: null; relay: SourceBook | null }>
  metrics: null
  errors: Partial<Record<'node' | 'relay' | 'rpc', string>>
}

export async function runDualReadRound(
  deps: DualReadDeps,
  chainId: number,
  pairs: readonly string[],
): Promise<DualReadRound> {
  const round = await runBookRound(deps, chainId, pairs)
  return {
    ...round,
    mode: 'active',
    metrics: null,
    books: round.books.map((b) => ({ pair: b.pair, node: null, relay: b.relay })),
  }
}
