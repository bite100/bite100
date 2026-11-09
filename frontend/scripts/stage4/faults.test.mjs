#!/usr/bin/env node
// 第 50 轮故障注入自检：针对第 48 轮推送后 ChatGPT 复审的运行器
// 条件项（2 P1 + 2 P2），按 ChatGPT 建议的四个故障注入场景验证
// 修复后的失败关闭行为。与 soak 的 timing.test.mjs 同法：用仓库
// 既有 esbuild 把 faults.entry.ts（只再导出 engine 的账本/恢复/
// 对账逻辑 + SETTLEMENT_ABI）打成 Node 产物，链侧全部用结构假件
// （假 provider / 假 settlementRead），不连真链、不读密钥。
//
// 场景映射：
//   F1a–F1e 账本层（P1 首次创建崩溃窗 + P2 全字段校验/冲突合并）
//   F1f     场景① .tmp 遗留 → 重启恢复全程（采用 + 链上确认 + 清账）
//   F2      场景④ probe 行已写、pending 未清时进程被杀 → 重启走
//           落盘判重，不重复确认、不重复追加 probe 行、不重复计数
//   F3      场景② 交易卡 mempool 后迟到上链 → 隔离对账经事件扫描
//           认回并计数、对账报 complete
//   F4      场景③ 对账时回执不可验真（status=0）→ 对账不报
//           complete、抛错保隔离、不计数
//   F4-slow 场景③变体：回执始终取不到（null）——与 F4 走同一
//           `!receipt || status !== 1` 分支，但须等满生产宽限
//           120s 才返回，默认跳过；S4_FAULTS_INCLUDE_SLOW=1 时跑。
//
// 用法：frontend 内 `node scripts/stage4/faults.test.mjs`
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ethers } from 'ethers'

const here = dirname(fileURLToPath(import.meta.url))
const bundleDir = mkdtempSync(join(tmpdir(), 'stage4-faults-bundle-'))
const bundlePath = join(bundleDir, 'faults.bundle.mjs')

await build({
  entryPoints: [join(here, 'faults.entry.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  define: { 'import.meta.env': '{}' },
  banner: {
    js: "import { createRequire as __s4CreateRequire } from 'node:module'; const require = __s4CreateRequire(import.meta.url);",
  },
  logLevel: 'silent',
})

const {
  Stage4Ledger,
  PendingLedgerCorruptError,
  recoverPendingSettlements,
  reconcileAfterTimeout,
  SETTLEMENT_ABI,
} = await import(bundlePath)

// ------------------------------------------------------------ 假件

const CHAIN = 11155111
const SETTLEMENT = '0x3000000000000000000000000000000000000003'
const MAKER = '0x1000000000000000000000000000000000000001'
const TAKER = '0x2000000000000000000000000000000000000002'
const TOKEN_IN = '0x4000000000000000000000000000000000000004'
const TOKEN_OUT = '0x5000000000000000000000000000000000000005'

const settleIface = new ethers.Interface(SETTLEMENT_ABI)

function tradeLog(txHash) {
  const { topics, data } = settleIface.encodeEventLog('TradeSettled', [
    MAKER,
    TAKER,
    TOKEN_IN,
    TOKEN_OUT,
    100n,
    200n,
    1n,
  ])
  return {
    address: SETTLEMENT,
    topics,
    data,
    transactionHash: txHash,
    blockNumber: 950,
    index: 0,
  }
}

function pendingEntry(txHash, overrides = {}) {
  return {
    txHash,
    chainId: CHAIN,
    pair: 'ETH/USDT',
    takerDigest: '0x' + 'ab'.repeat(32),
    legs: 1,
    takerAmountIn: '1000',
    notedAt: 1762000000000,
    ...overrides,
  }
}

function makeLedger(dir) {
  const metricsPath = join(dir, 'metrics.jsonl')
  const statePath = join(dir, 'state.json')
  const pendingPath = join(dir, 'pending.json')
  const ledger = new Stage4Ledger(
    metricsPath,
    statePath,
    pendingPath,
    Date.now(),
    Date.now() + 3600_000,
  )
  return { ledger, metricsPath, statePath, pendingPath }
}

function readMetrics(metricsPath) {
  if (!existsSync(metricsPath)) return []
  return readFileSync(metricsPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

/** 假 ChainCtx：只实现 engine 对账/确认路径实际触碰的字段 */
function fakeCtx({ receipts = new Map(), logs = [], latest = 1000, filledIn = 500n } = {}) {
  const calls = { receipt: 0, getLogs: 0 }
  const ctx = {
    chainId: CHAIN,
    chainCfg: { contracts: { settlement: SETTLEMENT } },
    provider: {
      getBlockNumber: async () => latest,
      getLogs: async () => {
        calls.getLogs += 1
        return logs
      },
      getTransactionReceipt: async (hash) => {
        calls.receipt += 1
        return receipts.get(hash.toLowerCase()) ?? null
      },
    },
    settlementRead: { orderFilledIn: async () => filledIn },
    maker: { address: MAKER },
    taker: { address: TAKER },
  }
  return { ctx, calls }
}

const okReceipt = (txHash) => ({ status: 1, logs: [tradeLog(txHash)] })

// ------------------------------------------------------------  harness

let failures = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (e) {
    failures += 1
    console.error(`FAIL ${name}\n  ${e instanceof Error ? e.stack : String(e)}`)
  }
}

const TX = (n) => '0x' + n.toString(16).padStart(64, '0')

// ------------------------------------------------------------  F1 账本层

await check('F1a .tmp 遗留（主文件缺失）→ 采用并愈合布局', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's4-f1a-'))
  const { ledger, pendingPath } = makeLedger(dir)
  const entry = pendingEntry(TX(0xf1a))
  writeFileSync(`${pendingPath}.tmp`, JSON.stringify([entry], null, 2))
  const rows = ledger.loadPending()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].txHash, entry.txHash)
  assert.equal(rows[0].legs, 1)
  assert.equal(existsSync(pendingPath), true, '采用后主文件应被 rename 愈合')
  assert.equal(existsSync(`${pendingPath}.tmp`), false)
})

await check('F1b .tmp 遗留但 JSON 损坏 → PendingLedgerCorruptError 失败关闭', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's4-f1b-'))
  const { ledger, pendingPath } = makeLedger(dir)
  writeFileSync(`${pendingPath}.tmp`, '{not-json')
  assert.throws(() => ledger.loadPending(), PendingLedgerCorruptError)
})

await check('F1c 主文件行缺字段（legs）→ 全字段校验拦截、失败关闭', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's4-f1c-'))
  const { ledger, pendingPath } = makeLedger(dir)
  const { legs: _drop, ...noLegs } = pendingEntry(TX(0xf1c))
  writeFileSync(pendingPath, JSON.stringify([noLegs]))
  assert.throws(() => ledger.loadPending(), PendingLedgerCorruptError)
})

await check('F1d 同 txHash 异内容重复条目 → 冲突失败关闭（禁止静默覆盖）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's4-f1d-'))
  const { ledger, pendingPath } = makeLedger(dir)
  const a = pendingEntry(TX(0xf1d))
  const b = pendingEntry(TX(0xf1d), { legs: 2 })
  writeFileSync(pendingPath, JSON.stringify([a, b]))
  assert.throws(() => ledger.loadPending(), PendingLedgerCorruptError)
})

await check('F1e 同 txHash 同内容重复条目 → 合并为一条', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's4-f1e-'))
  const { ledger, pendingPath } = makeLedger(dir)
  const a = pendingEntry(TX(0xf1e))
  writeFileSync(pendingPath, JSON.stringify([a, { ...a }]))
  const rows = ledger.loadPending()
  assert.equal(rows.length, 1)
})

await check('F1f 场景①：.tmp 遗留 → 重启恢复全程确认并清账', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's4-f1f-'))
  const { ledger, metricsPath, pendingPath } = makeLedger(dir)
  const entry = pendingEntry(TX(0xf1f))
  // 模拟首次 notePending 写完 .tmp、rename 前被 SIGKILL
  writeFileSync(`${pendingPath}.tmp`, JSON.stringify([entry], null, 2))
  const { ctx } = fakeCtx({
    receipts: new Map([[entry.txHash.toLowerCase(), okReceipt(entry.txHash)]]),
  })
  await recoverPendingSettlements(ledger, new Map([[CHAIN, ctx]]))
  assert.equal(ledger.counts[CHAIN].settlements, 1)
  assert.equal(ledger.pendingEntries().length, 0)
  const rows = readMetrics(metricsPath)
  assert.equal(rows.filter((r) => r.kind === 'probe' && r.txHash === entry.txHash).length, 1)
  assert.equal(
    rows.filter((r) => r.kind === 'recovery' && r.result === 'confirmed').length,
    1,
  )
})

// ------------------------------------------------------------  F2 跨进程幂等

await check('F2 场景④：probe 已写、pending 未清被杀 → 重启不重复确认/记账', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's4-f2-'))
  const entry = pendingEntry(TX(0xf2))
  // 进程 A：记账 → 写 probe 确认行 → 在清 pending 前被杀
  const a = makeLedger(dir)
  a.ledger.notePending(entry)
  a.ledger.line({
    kind: 'probe',
    ts: Date.now(),
    txHash: entry.txHash,
    chainId: CHAIN,
    pair: entry.pair,
    takerDigest: entry.takerDigest,
    legs: entry.legs,
    settledAt: Date.now(),
    events: [],
    probe: { receipt: 'ok', eventsMatch: 'ok', indexer: 'pending' },
  })
  // 进程 B：全新内存账本、同盘面文件
  const b = makeLedger(dir)
  const { ctx, calls } = fakeCtx({
    receipts: new Map([[entry.txHash.toLowerCase(), okReceipt(entry.txHash)]]),
  })
  await recoverPendingSettlements(b.ledger, new Map([[CHAIN, ctx]]))
  assert.equal(calls.receipt, 0, '已有落盘 probe 记录时不得再上链确认')
  const rows = readMetrics(b.metricsPath)
  assert.equal(
    rows.filter((r) => r.kind === 'probe' && r.txHash === entry.txHash).length,
    1,
    'probe 行不得重复追加（下游按行汇总会双计）',
  )
  assert.equal(
    rows.filter((r) => r.kind === 'recovery' && r.result === 'already-confirmed').length,
    1,
  )
  assert.equal(b.ledger.counts[CHAIN].settlements, 0, '不得重复计数')
  assert.equal(b.ledger.pendingEntries().length, 0, 'pending 应被清掉')
})

// ------------------------------------------------------------  F3/F4 对账

await check('F3 场景②：迟到成交（事件扫描发现）回执正常 → 认回计数、对账 complete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's4-f3-'))
  const { ledger, metricsPath } = makeLedger(dir)
  const lateTx = TX(0xf3)
  const { ctx } = fakeCtx({
    logs: [tradeLog(lateTx)],
    receipts: new Map([[lateTx.toLowerCase(), okReceipt(lateTx)]]),
  })
  await reconcileAfterTimeout(ledger, {}, ctx, 900)
  assert.equal(ledger.counts[CHAIN].settlements, 1)
  assert.equal(ledger.counts[CHAIN].legs, 1)
  const rows = readMetrics(metricsPath)
  assert.equal(rows.filter((r) => r.result === 'late-settlement-recovered').length, 1)
  const final = rows.filter((r) => r.kind === 'reconcile' && r.result === 'complete')
  assert.equal(final.length, 1)
  assert.equal(final[0].lateRecovered, 1)
})

await check('F4 场景③：迟到成交回执 status=0 不可验真 → 抛错保隔离、不报 complete、不计数', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's4-f4-'))
  const { ledger, metricsPath } = makeLedger(dir)
  const lateTx = TX(0xf4)
  const { ctx } = fakeCtx({
    logs: [tradeLog(lateTx)],
    receipts: new Map([[lateTx.toLowerCase(), { status: 0, logs: [tradeLog(lateTx)] }]]),
  })
  await assert.rejects(() => reconcileAfterTimeout(ledger, {}, ctx, 900), /对账未完成/)
  assert.equal(ledger.counts[CHAIN].settlements, 0)
  const rows = readMetrics(metricsPath)
  assert.equal(rows.filter((r) => r.result === 'late-tx-unverified').length, 1)
  assert.equal(rows.filter((r) => r.result === 'incomplete-unverified-late-tx').length, 1)
  assert.equal(
    rows.filter((r) => r.kind === 'reconcile' && r.result === 'complete').length,
    0,
    '未验真时绝不得出现 complete 行（调用方据此删隔离）',
  )
})

if (process.env.S4_FAULTS_INCLUDE_SLOW === '1') {
  await check('F4-slow 场景③变体：回执始终取不到（等满 120s 宽限）→ 同样保隔离', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's4-f4s-'))
    const { ledger, metricsPath } = makeLedger(dir)
    const lateTx = TX(0xf45)
    const { ctx } = fakeCtx({ logs: [tradeLog(lateTx)], receipts: new Map() })
    await assert.rejects(() => reconcileAfterTimeout(ledger, {}, ctx, 900), /对账未完成/)
    assert.equal(ledger.counts[CHAIN].settlements, 0)
    const rows = readMetrics(metricsPath)
    assert.equal(rows.filter((r) => r.result === 'incomplete-unverified-late-tx').length, 1)
    assert.equal(rows.filter((r) => r.kind === 'reconcile' && r.result === 'complete').length, 0)
  })
} else {
  console.log('SKIP F4-slow（回执始终取不到变体，与 F4 同分支；设 S4_FAULTS_INCLUDE_SLOW=1 运行，须等满 120s 生产宽限）')
}

// ------------------------------------------------------------  收尾

if (failures > 0) {
  console.error(`\n${failures} 个场景失败`)
  process.exit(1)
}
console.log('\n全部故障注入场景通过')
