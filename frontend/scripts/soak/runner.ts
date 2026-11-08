/**
 * 合成压测（第 35 轮 D-10b）— 服务端影子轮次执行器。
 *
 * 每轮：经注入的适配器拉节点 + 本机中继两源书籍 → 复用前端 dualread 的
 * runDualReadRound（prepare/evaluate/merge/metrics 全部是同一套生产
 * 代码，不另写评估逻辑）→ 把本轮指标 + 过滤结果 + 发现记账追加写入
 * JSONL（逐轮落盘，进程重启可回放重建）。
 *
 * 第 34 轮 D7 的设计消解点：
 * - 观察记录在服务端落盘（JSONL），不再依赖浏览器页面内存；
 * - 每源首次发现时刻逐单记录（firstSeen），回放可重建；
 * - 发现成功率独立统计：已提交且超过宽限期的自造订单中，被至少一源
 *   发现的比例（分母只算生成器自己的订单，口径与「订单总数」分开）；
 * - 两个延迟分开记：orderAgeAtFirstSeenMs（首次发现时刻 − 订单创建
 *   时刻，含下单前年龄）与 propagationMs（首次发现时刻 − 提交时刻，
 *   纯传播延迟），不混为一谈。
 *
 * 适配器说明：节点适配器在本文件内以裸 fetch 实现（复用 dualread/
 * adapters 的 normalizeBookRows/sortBookSide 做行规范化与丢弃计数）——既有
 * createNodeBookAdapter 绑死浏览器端 nodeClient 的多节点配置，
 * 服务端需要按链指定任意节点 URL，故不复用其取数外壳；中继适配器
 * 直接复用 createRelayBookAdapter（合同与完整度口径一致）。
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import {
  createRelayBookAdapter,
  normalizeBookRows,
  sortBookSide,
  type BookAdapter,
} from '../../src/services/dualread/adapters'
import {
  createChainStateReader,
  createViemChainTransport,
  type ChainStateReader,
} from '../../src/services/dualread/chainState'
import {
  runDualReadRound,
  ShadowObserver,
  type DualReadRound,
} from '../../src/services/dualread/index'
import type {
  BookSource,
  RawOrder,
  SourceBook,
} from '../../src/services/dualread/types'
import type { GeneratedOrder, SubmitOutcome } from './generator'

export interface SoakChainConfig {
  chainId: number
  nodeUrl: string
  relayUrl: string
  pairs: string[]
}

function createDirectNodeAdapter(nodeUrl: string): BookAdapter {
  return {
    async fetchBook(chainId: number, pair: string): Promise<SourceBook> {
      const res = await fetch(
        `${nodeUrl}/api/orderbook?pair=${encodeURIComponent(pair)}`,
      )
      if (!res.ok) throw new Error(`node orderbook http ${res.status}`)
      const data = (await res.json()) as { bids?: unknown[]; asks?: unknown[] }
      const rawBids = data?.bids ?? []
      const rawAsks = data?.asks ?? []
      // 第 38 轮：与前端共用 normalizeBookRows 规范化 + 丢弃计数
      const nb = normalizeBookRows(rawBids)
      const na = normalizeBookRows(rawAsks)
      const bids = sortBookSide(nb.orders, 'buy')
      const asks = sortBookSide(na.orders, 'sell')
      return {
        source: 'node',
        chainId,
        pair,
        bids,
        asks,
        complete: true, // 节点 orderbook 全量开簿、无分页（与前端适配器同口径）
        fetchedAt: Date.now(),
        rawRows: rawBids.length + rawAsks.length,
        droppedRows: nb.droppedRows + na.droppedRows,
      }
    },
  }
}

export interface SubmittedRecord {
  digest: string
  chainId: number
  pair: string
  role: string
  side: string
  createdAt: number
  submittedAt: number
  nodeOk: boolean
  relayOk: boolean
  tampered: boolean
}

export interface FirstSeenEntry {
  digest: string
  source: BookSource
  firstSeenAt: number
  /** 首次发现时刻 − 订单创建时间（含提交前年龄） */
  orderAgeAtFirstSeenMs: number
  /** 首次发现时刻 − 提交时刻（纯传播延迟） */
  propagationMs: number
}

export interface RoundRecord {
  kind: 'round'
  ts: number
  chainId: number
  round: number
  metrics: DualReadRound['metrics']
  filterOutcomes: { valid: number; unknown: number; invalid: number; tradeable: number }
  submittedTotal: number
  /** 本轮节点源原始行数（全部交易对 bids+asks 合计；第 38 轮加法字段，旧 round 行无此字段） */
  nodeRawRows: number
  /** 本轮节点源被规范化丢弃的行数（第 38 轮；与 nodeRawRows 对照发现整源被字段形态吞掉） */
  nodeDroppedRows: number
  discovery: {
    /** 已提交且超过宽限期、至少一源接单成功、且未被标记篡改的自造订单数（第 38 轮起排除 tampered，与 report.mjs/§6.3 定义对齐） */
    eligible: number
    discoveredAny: number
    discoveredBoth: number
    successRate: number | null
  }
  newFirstSeen: FirstSeenEntry[]
  errors: DualReadRound['errors']
}

/** 压测记账状态：全部可由 JSONL 回放重建（submitted 行 + round 行） */
export class SoakLedger {
  submitted = new Map<string, SubmittedRecord>()
  firstSeen = new Map<string, Partial<Record<BookSource, number>>>()
  roundSeq = 0

  constructor(private readonly jsonlPath: string) {}

  /** 启动时回放既有 JSONL，重建提交与首次发现记账 */
  static load(jsonlPath: string): SoakLedger {
    const ledger = new SoakLedger(jsonlPath)
    if (!existsSync(jsonlPath)) return ledger
    for (const line of readFileSync(jsonlPath, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const rec = JSON.parse(line) as Record<string, unknown>
        if (rec.kind === 'submitted') {
          const s = rec as unknown as SubmittedRecord & { kind: string }
          ledger.submitted.set(s.digest.toLowerCase(), s)
        } else if (rec.kind === 'round') {
          const r = rec as unknown as RoundRecord
          ledger.roundSeq = Math.max(ledger.roundSeq, r.round)
          for (const fs of r.newFirstSeen ?? []) {
            const key = fs.digest.toLowerCase()
            const entry = ledger.firstSeen.get(key) ?? {}
            if (entry[fs.source] === undefined) entry[fs.source] = fs.firstSeenAt
            ledger.firstSeen.set(key, entry)
          }
        }
      } catch {
        // 损坏行跳过（落盘是追加写，尾行可能被中断），不阻塞压测
      }
    }
    return ledger
  }

  recordSubmitted(gen: GeneratedOrder, outcome: SubmitOutcome, tampered: boolean): void {
    const rec: SubmittedRecord = {
      digest: gen.digest.toLowerCase(),
      chainId: gen.chainId,
      pair: gen.pair,
      role: gen.role,
      side: gen.side,
      createdAt: gen.createdAt,
      // 第 36 轮 N4：用提交路径在发起瞬间打的点（outcome.submittedAt），
      // 不再以记账时刻冒充提交时刻。JSONL 字段名不变、口径变真。
      submittedAt: outcome.submittedAt,
      nodeOk: outcome.node,
      relayOk: outcome.relay,
      tampered,
    }
    this.submitted.set(rec.digest, rec)
    appendFileSync(this.jsonlPath, JSON.stringify({ kind: 'submitted', ...rec }) + '\n')
  }

  /** 一轮评估后更新首次发现记账，返回本轮新发现条目 */
  absorbRound(round: DualReadRound, nowMs: number): FirstSeenEntry[] {
    const fresh: FirstSeenEntry[] = []
    for (const view of round.views) {
      for (const o of view.all) {
        const key = o.identity.digest.toLowerCase()
        const sub = this.submitted.get(key)
        if (!sub) continue
        let entry = this.firstSeen.get(key)
        if (!entry) {
          entry = {}
          this.firstSeen.set(key, entry)
        }
        for (const src of o.sources) {
          if (entry[src] === undefined) {
            entry[src] = nowMs
            fresh.push({
              digest: key,
              source: src,
              firstSeenAt: nowMs,
              orderAgeAtFirstSeenMs: nowMs - sub.createdAt * 1000,
              propagationMs: nowMs - sub.submittedAt,
            })
          }
        }
      }
    }
    return fresh
  }

  discoveryStats(chainId: number, nowMs: number, graceMs: number): RoundRecord['discovery'] {
    let eligible = 0
    let discoveredAny = 0
    let discoveredBoth = 0
    for (const sub of this.submitted.values()) {
      if (sub.chainId !== chainId) continue
      if (sub.tampered) continue // 第 38 轮：与 report.mjs absorb() 及 §6.3「有效订单」定义对齐
      if (!sub.nodeOk && !sub.relayOk) continue
      if (nowMs - sub.submittedAt < graceMs) continue
      eligible += 1
      const seen = this.firstSeen.get(sub.digest)
      if (seen && (seen.node !== undefined || seen.relay !== undefined)) {
        discoveredAny += 1
        if (seen.node !== undefined && seen.relay !== undefined) discoveredBoth += 1
      }
    }
    return {
      eligible,
      discoveredAny,
      discoveredBoth,
      successRate: eligible > 0 ? discoveredAny / eligible : null,
    }
  }

  appendRound(rec: RoundRecord): void {
    appendFileSync(this.jsonlPath, JSON.stringify(rec) + '\n')
  }
}

export interface SoakRunner {
  runRound(cfg: SoakChainConfig): Promise<RoundRecord>
  ledger: SoakLedger
}

export function createSoakRunner(jsonlPath: string, graceMs = 60_000): SoakRunner {
  const ledger = SoakLedger.load(jsonlPath)
  const observer = new ShadowObserver()
  const chainReader: ChainStateReader = createChainStateReader(createViemChainTransport())
  return {
    ledger,
    async runRound(cfg: SoakChainConfig): Promise<RoundRecord> {
      const round = await runDualReadRound(
        {
          mode: 'shadow',
          nodeAdapter: createDirectNodeAdapter(cfg.nodeUrl),
          relayAdapter: createRelayBookAdapter(cfg.relayUrl),
          chainReader,
          observer,
        },
        cfg.chainId,
        cfg.pairs,
      )
      const nowMs = Date.now()
      const newFirstSeen = ledger.absorbRound(round, nowMs)
      const all = round.views.flatMap((v) => v.all)
      const tradeable = round.views.reduce((n, v) => n + v.tradeable.length, 0)
      ledger.roundSeq += 1
      const rec: RoundRecord = {
        kind: 'round',
        ts: nowMs,
        chainId: cfg.chainId,
        round: ledger.roundSeq,
        metrics: round.metrics,
        filterOutcomes: {
          valid: all.filter((o) => o.validity === 'VALID').length,
          unknown: all.filter((o) => o.validity === 'UNKNOWN').length,
          invalid: all.filter((o) => o.validity === 'INVALID').length,
          tradeable,
        },
        submittedTotal: [...ledger.submitted.values()].filter(
          (s) => s.chainId === cfg.chainId,
        ).length,
        nodeRawRows: round.books.reduce((n, b) => n + (b.node?.rawRows ?? 0), 0),
        nodeDroppedRows: round.books.reduce((n, b) => n + (b.node?.droppedRows ?? 0), 0),
        discovery: ledger.discoveryStats(cfg.chainId, nowMs, graceMs),
        newFirstSeen,
        errors: round.errors,
      }
      ledger.appendRound(rec)
      return rec
    },
  }
}
