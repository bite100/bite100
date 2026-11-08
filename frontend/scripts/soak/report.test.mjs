#!/usr/bin/env node
// 第 37 轮块 4 自检：report.mjs 的回放口径（与 SoakLedger /
// discoveryStats 同语义）。夹具 JSONL 写临时目录，spawn 报告工具
// 以 --json 运行并断言计数。`npm run test:soak-report`。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const tool = join(here, 'report.mjs')
const dir = mkdtempSync(join(tmpdir(), 'soak-report-selftest-'))

const T0 = 1_700_000_000_000
const sub = (digest, chainId, pair, over = {}) =>
  JSON.stringify({
    kind: 'submitted', digest, chainId, pair, role: 'maker', side: 'buy',
    createdAt: (T0 - 60_000) / 1000, submittedAt: T0,
    nodeOk: true, relayOk: true, tampered: false, ...over,
  })
const round = (chainId, n, firstSeenDigests) =>
  JSON.stringify({
    kind: 'round', ts: T0 + 10 * 60_000, chainId, round: n,
    metrics: {},
    filterOutcomes: { valid: 3, unknown: 0, invalid: 0, tradeable: 0 },
    submittedTotal: 0,
    discovery: { eligible: 0, discoveredAny: 0, discoveredBoth: 0, successRate: null },
    newFirstSeen: firstSeenDigests.flatMap((d) => [
      { digest: d, source: 'node', firstSeenAt: T0 + 60_000, orderAgeAtFirstSeenMs: 0, propagationMs: 60_000 },
      { digest: d, source: 'relay', firstSeenAt: T0 + 61_000, orderAgeAtFirstSeenMs: 0, propagationMs: 61_000 },
    ]),
    errors: {},
  })

const lines = [
  sub('0xaaa', 11155111, 'BTC/USDT'),
  sub('0xbbb', 11155111, 'BTC/USDT', { relayOk: false }),
  sub('0xccc', 11155111, 'ETH/USDT', { nodeOk: false, relayOk: false }), // 双源皆拒：不计有效
  sub('0xddd', 11155111, 'ETH/USDT', { tampered: true }), // 篡改单：单独计数
  sub('0xeee', 84532, 'BTC/USDT'),
  round(11155111, 1, ['0xaaa', '0xbbb']),
  round(84532, 1, []),
  '{bad json line',
]
const fixture = join(dir, 'fixture.jsonl')
writeFileSync(fixture, lines.join('\n') + '\n')

const r = spawnSync(process.execPath, [tool, '--file', fixture, '--json'], { encoding: 'utf8' })
let failed = 0
const check = (name, cond) => {
  if (cond) console.log(`自检通过：${name}`)
  else { failed++; console.error(`自检失败：${name}`) }
}
check('工具退出码 0', r.status === 0)
let out
try { out = JSON.parse(r.stdout) } catch { out = null }
check('输出可解析 JSON', !!out)
if (out) {
  const sep = out.chains['11155111']
  const base = out.chains['84532']
  check('Sepolia 已提交 4（含双拒与篡改）', sep.submitted === 4)
  check('Sepolia 有效样本 = 2（双接 0xaaa + 单接 0xbbb）', sep.eligible === 2)
  check('Sepolia 发现成功率 = 1（两单双源发现）', sep.discoverySuccessRate === 1 && sep.discoveredBoth === 2)
  check('Sepolia 篡改单独计数 = 1', sep.tampered === 1)
  check('Base 已提交 1 且有效 1', base.submitted === 1 && base.eligible === 1)
  check('Base 未被发现 → 成功率 0', base.discoverySuccessRate === 0)
  const eth = out.pairs['11155111|ETH/USDT']
  check('ETH/USDT 对：提交 2、有效 0', eth.submitted === 2 && eth.eligible === 0)
  check('损坏行计 1', out.badLines === 1)
  check('无含可成交单轮次', out.roundsWithTradeable === 0)
}
if (failed > 0) {
  console.error(`soak report 自检失败：${failed} 项`)
  process.exit(1)
}
console.log('soak report 自检全部通过')
