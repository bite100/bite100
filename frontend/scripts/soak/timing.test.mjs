#!/usr/bin/env node
// 第 36 轮 N4 自检：soak 提交时刻必须是「逐单真实提交时刻」，不是
// 整批结束后的记账时刻（旧口径系统性低估批次内靠前订单的传播延迟）。
//
// 方法：用仓库既有 esbuild（与 build.mjs 同一路）把 timing.entry.ts
// 打成 Node 产物，替换 globalThis.fetch 为记录到达时刻的桩，跑一
// 批 3 单（间隔 40ms），断言：
//   1. 三单 submittedAt 互不相同、严格递增，间隔与提交间隔同量级；
//   2. 每单 submittedAt 不晚于它首个网络请求的到达时刻（在提交
//      路径内、先于 fetch 打点），且第一单的 submittedAt 明显早于
//      整批结束时刻（若回归成批次后打点，此条必挂）；
//   3. SoakLedger.recordSubmitted 落盘 JSONL 的 submittedAt 与
//      outcome.submittedAt 逐字相等（穿线完整，字段名不变）。
// 零新增依赖；用法：frontend 内 `npm run test:soak-timing`。
import { build } from 'esbuild'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'soak-timing-selftest-'))
const bundlePath = join(dir, 'timing.bundle.mjs')

await build({
  entryPoints: [join(here, 'timing.entry.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  define: { 'import.meta.env': '{}' },
  banner: {
    js: "import { createRequire as __soakCreateRequire } from 'node:module'; const require = __soakCreateRequire(import.meta.url);",
  },
  logLevel: 'silent',
})

const { submitBatch, SoakLedger } = await import(bundlePath)

// fetch 桩：记录每次请求的到达时刻与订单标记（body.orderId），恒成功。
const arrivals = []
globalThis.fetch = async (url, opts) => {
  let tag = ''
  try {
    tag = JSON.parse(opts?.body ?? '{}').orderId ?? ''
  } catch {
    /* 桩不关心解析失败 */
  }
  arrivals.push({ url: String(url), at: Date.now(), tag })
  return { ok: true, status: 200, text: async () => '' }
}

function fakeGen(i) {
  return {
    chainId: 11155111,
    digest: '0x' + String(i).padStart(64, '0'),
    role: 'maker',
    pair: 'BTC/USDT',
    side: 'sell',
    body: { orderId: `timing_${i}` },
    createdAt: 1700000000,
  }
}

let failed = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`自检通过：${name}`)
  else {
    failed++
    console.error(`自检失败：${name}${detail ? `（${detail}）` : ''}`)
  }
}

const gens = [fakeGen(1), fakeGen(2), fakeGen(3)]
const results = await submitBatch(
  'http://node.invalid',
  'http://relay.invalid',
  gens,
  40,
)
const batchEnd = Date.now()
const stamps = results.map((r) => r.outcome.submittedAt)

check('批次返回 3 单结果', results.length === 3)
check(
  'submittedAt 严格递增（逐单打点、互不相同）',
  stamps[0] < stamps[1] && stamps[1] < stamps[2],
  `stamps=${stamps.join(',')}`,
)
check(
  '相邻 submittedAt 间隔与提交间隔同量级（≥25ms，名义 40ms）',
  stamps[1] - stamps[0] >= 25 && stamps[2] - stamps[1] >= 25,
  `gaps=${stamps[1] - stamps[0]},${stamps[2] - stamps[1]}`,
)
// 每单首个请求 = 该单的节点 POST（无改写注入时先节点后中继）
for (let i = 0; i < 3; i++) {
  const firstArrival = arrivals.find((a) => a.tag === `timing_${i + 1}`)
  check(
    `第 ${i + 1} 单 submittedAt 不晚于其首个网络请求到达时刻`,
    firstArrival !== undefined && stamps[i] <= firstArrival.at + 5,
    `stamp=${stamps[i]} arrival=${firstArrival?.at}`,
  )
}
check(
  '第一单 submittedAt 明显早于整批结束（非批次后补记）',
  batchEnd - stamps[0] >= 70,
  `batchEnd-stamp0=${batchEnd - stamps[0]}ms`,
)

const jsonlPath = join(dir, 'ledger.jsonl')
const ledger = new SoakLedger(jsonlPath)
ledger.recordSubmitted(gens[0], results[0].outcome, false)
const line = JSON.parse(readFileSync(jsonlPath, 'utf8').trim())
check(
  'recordSubmitted 落盘 submittedAt 与 outcome.submittedAt 逐字相等（穿线完整）',
  line.submittedAt === results[0].outcome.submittedAt,
  `jsonl=${line.submittedAt} outcome=${results[0].outcome.submittedAt}`,
)

if (failed > 0) {
  console.error(`soak 计时自检失败：${failed} 项未达预期`)
  process.exit(1)
}
console.log('soak 计时自检全部通过')
