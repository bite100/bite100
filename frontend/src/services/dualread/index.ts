/**
 * 第 34 轮双读 — 一轮双读的编排入口。
 *
 * mode=disabled：直接返回，不拉任何源（生产零变化）。
 * mode=shadow/active：按交易对拉节点 + 公告栏两源书籍 → 重构/验签 →
 * 一次链上批量快照（全对共享）→ 逐对合并评估 → 影子指标。
 * 合并视图是否进入展示由调用方按 mode 决定：shadow 下只供观察，
 * 生产订单簿保持节点单读（简报口径）。
 */
import { RELAY_MODE, type RelayMode } from '../../config/relay'
import {
  createNodeBookAdapter,
  createRelayBookAdapter,
  type BookAdapter,
} from './adapters'
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
import {
  ShadowObserver,
  computeShadowMetrics,
  type ShadowMetrics,
} from './metrics'
import type { MergedView, SourceBook } from './types'

export * from './types'
export { buildSignedOrderData, computeOrderDigest, hashOrderWithDomain } from './digest'
export { createNodeBookAdapter, createRelayBookAdapter, toRawOrder, sortBookSide } from './adapters'
export {
  createChainStateReader,
  createViemChainTransport,
  assembleChainState,
  buildStateCalls,
} from './chainState'
export {
  prepareCandidates,
  evaluateCandidate,
  mergeBooks,
  unsignedFieldConflict,
  normalizeExecType,
  deriveSideFromLock,
} from './evaluate'
export { ShadowObserver, computeShadowMetrics } from './metrics'
export { SIDE_PROOF_AVAILABLE, SIDE_UNPROVABLE } from './protocol'
export type { ShadowMetrics, BookSideDiff, Ratio } from './metrics'

export interface DualReadDeps {
  mode?: RelayMode
  nodeAdapter?: BookAdapter
  relayAdapter?: BookAdapter
  chainReader?: ChainStateReader
  observer?: ShadowObserver
  verify?: VerifyFn
}

export interface DualReadRound {
  mode: RelayMode
  chainId: number
  views: MergedView[]
  books: Array<{ pair: string; node: SourceBook | null; relay: SourceBook | null }>
  chainOk: boolean
  chainStale: boolean
  metrics: ShadowMetrics | null
  errors: Partial<Record<'node' | 'relay' | 'rpc', string>>
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export async function runDualReadRound(
  deps: DualReadDeps,
  chainId: number,
  pairs: string[],
): Promise<DualReadRound> {
  const mode = deps.mode ?? RELAY_MODE
  const empty: DualReadRound = {
    mode,
    chainId,
    views: [],
    books: [],
    chainOk: false,
    chainStale: false,
    metrics: null,
    errors: {},
  }
  if (mode === 'disabled') return empty

  const nodeAdapter = deps.nodeAdapter ?? createNodeBookAdapter()
  const relayAdapter = deps.relayAdapter ?? createRelayBookAdapter()
  const chainReader =
    deps.chainReader ?? createChainStateReader(createViemChainTransport())
  const observer = deps.observer ?? new ShadowObserver()
  const errors: DualReadRound['errors'] = {}

  // 1) 两源拉取（逐对并行；单源失败只降级该源，不拖垮整轮）
  const books: DualReadRound['books'] = []
  let nodeAnyOk = false
  let relayAnyOk = false
  for (const pair of pairs) {
    const [nodeRes, relayRes] = await Promise.allSettled([
      nodeAdapter.fetchBook(chainId, pair),
      relayAdapter.fetchBook(chainId, pair),
    ])
    const node = nodeRes.status === 'fulfilled' ? nodeRes.value : null
    const relay = relayRes.status === 'fulfilled' ? relayRes.value : null
    if (node) nodeAnyOk = true
    else errors.node = errMsg((nodeRes as PromiseRejectedResult).reason)
    if (relay) relayAnyOk = true
    else errors.relay = errMsg((relayRes as PromiseRejectedResult).reason)
    books.push({ pair, node, relay })
  }
  observer.recordAvailability('node', nodeAnyOk)
  observer.recordAvailability('relay', relayAnyOk)

  // 2) 逐对重构 + 本地验签；汇总链上请求（本地未过的补链上验签材料）
  const preparedByPair = new Map<string, Awaited<ReturnType<typeof prepareCandidates>>>()
  const chainRequests: ChainStateRequest[] = []
  const seenDigests = new Set<string>()
  for (const { pair, node, relay } of books) {
    const prepared = await prepareCandidates(chainId, [node, relay], deps.verify)
    preparedByPair.set(pair, prepared)
    for (const cand of prepared.candidates) {
      const dkey = cand.identity.digest.toLowerCase()
      if (seenDigests.has(dkey)) continue
      seenDigests.add(dkey)
      const firstRaw = cand.raws.node ?? cand.raws.relay
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
  observer.recordAvailability('rpc', chainOk)

  // 4) 逐对合并评估 + 指标
  const views = books.map(({ pair }) =>
    mergeBooks(chainId, pair, preparedByPair.get(pair)!, chain),
  )
  const nowMs = Date.now()
  observer.observeOrders(views.flatMap((v) => v.all), nowMs)
  const metrics = computeShadowMetrics(
    { views, books, chainOk, nowMs },
    observer,
  )
  return {
    mode,
    chainId,
    views,
    books,
    chainOk,
    chainStale: Boolean(chain?.stale),
    metrics,
    errors,
  }
}
