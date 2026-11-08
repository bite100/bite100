#!/usr/bin/env node
/**
 * 挂单计量 CLI（第 42 轮 块 B）：离线双周计量入口。
 *
 * 输入（全部来自既有设施的导出，不新建采集）：
 * - --orders：中继 D1 `orders` 表导出 JSON（数组；字段 digest /
 *   user_address / pair / amount / price / created_at / expires_at，
 *   与 relay/migrations/0001_init.sql 同名）；
 * - --trades：Envio 索引器 Trade 实体导出 JSON（数组；字段 makerDigest /
 *   takerDigest / amountIn / blockTimestamp / digestAssociated）。
 * 参数：--period-start / --period-end（Unix 秒）、--cap（可选，quote wei）。
 *
 * 拼装口径：按 digest 累计成交 amountIn，达到订单 amountIn 的那笔成交的
 * blockTimestamp 即 filledAt（全量成交关闭时刻）。注意近似：Trade.amountIn
 * 是成交笔的入量，maker/taker 两侧订单共用同一笔记录——按 digest 分别
 * 累计是统计层近似，权威 filledIn 在 Settlement 链上状态（dualread 快照），
 * 口径边界见 docs/round42-weights-gas-vault-2026-11-08.md。
 * digestAssociated=false / digest 为 null 的成交不参与关联（绝不猜测归并）。
 *
 * 输出：per-address 挂单积分 JSON（stdout），即合约 submitProof
 * （nodeType=1）postingMetric 的原始积分输入（合约侧再按 CAP_POSTING 归一）。
 */
import { readFileSync } from 'node:fs'
import {
  meterPostings,
  type PostingLifecycleRecord,
} from '../../src/services/contribution/postingMeter'

interface D1OrderRow {
  digest: string
  user_address: string
  pair: string
  amount: string
  price: string
  created_at: number
  expires_at: number
}

interface IndexerTradeRow {
  makerDigest: string | null
  takerDigest: string | null
  amountIn: string
  blockTimestamp: number
  digestAssociated: boolean
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function required(name: string): string {
  const v = arg(name)
  if (!v) {
    console.error(`missing --${name}`)
    process.exit(2)
  }
  return v
}

const orders = JSON.parse(readFileSync(required('orders'), 'utf8')) as D1OrderRow[]
const trades = JSON.parse(readFileSync(required('trades'), 'utf8')) as IndexerTradeRow[]
const periodStart = Number(required('period-start'))
const periodEnd = Number(required('period-end'))
const cap = arg('cap')

// digest → 成交列表（按时间排序后累计）
const fillsByDigest = new Map<string, Array<{ amountIn: bigint; ts: number }>>()
for (const t of trades) {
  if (!t.digestAssociated) continue
  for (const d of [t.makerDigest, t.takerDigest]) {
    if (!d) continue
    const key = d.toLowerCase()
    const list = fillsByDigest.get(key) ?? []
    try {
      list.push({ amountIn: BigInt(t.amountIn), ts: t.blockTimestamp })
    } catch {
      // 非法 amountIn 的成交行跳过，不中断计量
    }
    fillsByDigest.set(key, list)
  }
}

function filledAtFor(order: D1OrderRow): number | null {
  const fills = fillsByDigest.get(order.digest.toLowerCase())
  if (!fills) return null
  let target: bigint
  try {
    target = BigInt(order.amount)
  } catch {
    return null
  }
  let acc = 0n
  for (const f of [...fills].sort((a, b) => a.ts - b.ts)) {
    acc += f.amountIn
    if (acc >= target) return f.ts
  }
  return null
}

const records: PostingLifecycleRecord[] = orders.map((o) => ({
  digest: o.digest,
  maker: o.user_address,
  pair: o.pair,
  amountIn: o.amount,
  price: o.price,
  createdAt: o.created_at,
  expiresAt: o.expires_at,
  filledAt: filledAtFor(o),
}))

const scores = meterPostings(records, {
  periodStart,
  periodEnd,
  ...(cap ? { notionalCapPerPair: BigInt(cap) } : {}),
})

console.log(JSON.stringify({ periodStart, periodEnd, scores }, null, 2))
