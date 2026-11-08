#!/usr/bin/env node
// 第 37 轮块 4 — 3A 收官聚合报告（只读）。
//
// 对 soak JSONL（runner.ts 的 SoakLedger 落盘格式）做离线回放，
// 按 SoakLedger.load / discoveryStats 的同一语义重建记账，输出
// 按链、按交易对的覆盖与计数。只读：不写任何文件，不连网。
//
// 「有效订单」口径（docs/round34 §6.3 第 37 轮写死）：
//   一张自造订单计入某链的有效样本 ⇔ 已提交（submitted 行）
//   ∧ 至少一个来源接单成功（nodeOk ∨ relayOk）
//   ∧ 报告时刻已过发现宽限（submittedAt + grace ≤ now）。
//   发现成功率 = 其中被任一来源在影子轮次中实际发现（firstSeen
//   有记录）的占比；双源发现率同理（两源都有 firstSeen）。
//   篡改单（tampered=true）是生成器真值的一部分：单独计数，
//   不计入有效样本（其提交路径与正常单不同，见 generator）。
//
// 用法：node scripts/soak/report.mjs --file <jsonl> [--grace-ms 60000]
//       [--target 500] [--now <epochMs>] [--json]
// now 缺省取文件内最大时间戳（对快照确定性重放）。
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
function argVal(name, dflt) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : dflt
}
const file = argVal('--file', null)
if (!file) {
  console.error('用法：node scripts/soak/report.mjs --file <soak-metrics.jsonl> [--grace-ms 60000] [--target 500] [--now <ms>] [--json]')
  process.exit(2)
}
const graceMs = Number(argVal('--grace-ms', '60000'))
const target = Number(argVal('--target', '500'))
const asJson = args.includes('--json')

const submitted = new Map()
const firstSeen = new Map()
let rounds = 0
let badLines = 0
let maxTs = 0
const filterSums = { valid: 0, unknown: 0, invalid: 0, tradeable: 0 }
let roundsWithTradeable = 0
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue
  let rec
  try {
    rec = JSON.parse(line)
  } catch {
    badLines++
    continue
  }
  if (rec.kind === 'submitted') {
    submitted.set(String(rec.digest).toLowerCase(), rec)
    maxTs = Math.max(maxTs, rec.submittedAt ?? 0)
  } else if (rec.kind === 'round') {
    rounds++
    maxTs = Math.max(maxTs, rec.ts ?? 0)
    const fo = rec.filterOutcomes ?? {}
    for (const k of Object.keys(filterSums)) filterSums[k] += Number(fo[k] ?? 0)
    if (Number(fo.tradeable ?? 0) > 0) roundsWithTradeable++
    for (const fs of rec.newFirstSeen ?? []) {
      const key = String(fs.digest).toLowerCase()
      const entry = firstSeen.get(key) ?? {}
      if (entry[fs.source] === undefined) entry[fs.source] = fs.firstSeenAt
      firstSeen.set(key, entry)
    }
  }
}
const nowMs = Number(argVal('--now', String(maxTs)))

function bucket() {
  return {
    submitted: 0, nodeOk: 0, relayOk: 0, bothOk: 0, anyOk: 0,
    tampered: 0, eligible: 0, discoveredAny: 0, discoveredBoth: 0,
  }
}
function absorb(b, s) {
  b.submitted++
  if (s.nodeOk) b.nodeOk++
  if (s.relayOk) b.relayOk++
  if (s.nodeOk && s.relayOk) b.bothOk++
  if (s.nodeOk || s.relayOk) b.anyOk++
  if (s.tampered) { b.tampered++; return }
  if (!(s.nodeOk || s.relayOk)) return
  if (nowMs - s.submittedAt < graceMs) return
  b.eligible++
  const seen = firstSeen.get(String(s.digest).toLowerCase())
  if (seen && (seen.node !== undefined || seen.relay !== undefined)) {
    b.discoveredAny++
    if (seen.node !== undefined && seen.relay !== undefined) b.discoveredBoth++
  }
}
const byChainPair = new Map()
const byChain = new Map()
for (const s of submitted.values()) {
  const ck = String(s.chainId)
  const pk = `${s.chainId}|${s.pair}`
  if (!byChain.has(ck)) byChain.set(ck, bucket())
  if (!byChainPair.has(pk)) byChainPair.set(pk, bucket())
  absorb(byChain.get(ck), s)
  absorb(byChainPair.get(pk), s)
}
const rate = (n, d) => (d > 0 ? n / d : null)
const chains = {}
for (const [ck, b] of byChain) {
  chains[ck] = {
    ...b,
    discoverySuccessRate: rate(b.discoveredAny, b.eligible),
    discoveryBothRate: rate(b.discoveredBoth, b.eligible),
    target,
    eligibleVsTarget: `${b.eligible}/${target}`,
    meetsTarget: b.eligible >= target,
  }
}
const pairs = {}
for (const [pk, b] of byChainPair) {
  const [chainId, pair] = pk.split('|')
  pairs[pk] = { chainId: Number(chainId), pair, ...b, discoverySuccessRate: rate(b.discoveredAny, b.eligible) }
}
const summary = {
  file, nowMs, graceMs, rounds, badLines,
  submittedTotal: submitted.size,
  filterOutcomeSumsAcrossRounds: filterSums,
  roundsWithTradeable,
  chains, pairs,
}
if (asJson) {
  console.log(JSON.stringify(summary, null, 2))
} else {
  const pct = (r) => (r === null ? '—' : `${(r * 100).toFixed(1)}%`)
  console.log(`3A 压测聚合（只读回放）：${file}`)
  console.log(`轮次 ${rounds} · 已提交 ${submitted.size} · 损坏行 ${badLines} · 含可成交单的轮次 ${roundsWithTradeable}`)
  for (const [ck, c] of Object.entries(chains)) {
    console.log(`\n链 ${ck}：有效样本 ${c.eligible}/${target} ${c.meetsTarget ? '✓达线' : '（未达线）'} · 发现成功率 ${pct(c.discoverySuccessRate)} · 双源发现率 ${pct(c.discoveryBothRate)} · 篡改单 ${c.tampered}`)
  }
  console.log('\n按交易对：')
  for (const p of Object.values(pairs)) {
    console.log(`  ${p.chainId} ${p.pair}: 提交 ${p.submitted} · 节点接单 ${p.nodeOk} · 中继接单 ${p.relayOk} · 双接 ${p.bothOk} · 有效 ${p.eligible} · 已发现 ${p.discoveredAny} · 篡改 ${p.tampered}`)
  }
}
