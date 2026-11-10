#!/usr/bin/env node
// 第 59 轮块 5：阶段 4 运行器配置解析自检。背景：第 55 轮 ChatGPT
// 审查半 B 点名 S4_CHAINS / S4_PAIRS 解析与 runCheck 代表对规则
// 「无自动测试、靠人工背书」（r58 已修代表对跟随子集，但同样未落
// 测试）。与 faults.test.mjs 同法：仓库既有 esbuild 打包
// config.entry.ts（只再导出 engine 的解析纯函数），node:assert
// 驱动；纯函数自检，不连真链、不读密钥。
//
// 覆盖：
//   C1 缺省：未设置 → 双链 / 全 8 对（与第 55 轮前行为逐字一致）
//   C2 子集：单链、链序保序去重；交易对子集保序
//   C3 失败关闭：显式设置但为空 / 含空项（双逗号、结尾逗号、纯空白）
//      → 抛错拒绝启动（第 58 轮收紧口径）
//   C4 白名单：未知链 id / 未登记交易对 / 非数字链 id → 抛错
//   C5 代表对（pickCheckPair）：子集含 DEFAULT_PAIR 用它、不含用
//      子集首对、缺省全集 → DEFAULT_PAIR（cycle 回落与 runCheck
//      预检共用同一实现，两处口径由本条钉住不漂移）
//
// 用法：frontend 内 `npm run test:stage4-config`
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundleDir = mkdtempSync(join(tmpdir(), 'stage4-config-bundle-'))
const bundlePath = join(bundleDir, 'config.bundle.mjs')

await build({
  entryPoints: [join(here, 'config.entry.ts')],
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

const { CHAINS, DEFAULT_PAIR, TRADE_PAIRS, parseChains, parseCsvList, parsePairs, pickCheckPair } =
  await import(bundlePath)

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL - ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// C1 缺省
check('C1a parseChains(undefined) = 双链缺省', () => {
  assert.deepEqual(parseChains(undefined), [11155111, 84532])
  assert.deepEqual(parseChains(undefined), [...CHAINS])
})
check('C1b parsePairs(undefined) = 全 8 对缺省', () => {
  assert.deepEqual(parsePairs(undefined), [...TRADE_PAIRS])
  assert.equal(TRADE_PAIRS.length, 8)
})
check('C1c parseCsvList(undefined) = null（用缺省信号）', () => {
  assert.equal(parseCsvList(undefined, 'S4_X'), null)
})

// C2 子集与保序去重
check('C2a 单链子集', () => {
  assert.deepEqual(parseChains('11155111'), [11155111])
  assert.deepEqual(parseChains('84532'), [84532])
})
check('C2b 链序按给定顺序、重复去重、空白容忍', () => {
  assert.deepEqual(parseChains(' 84532 , 11155111 , 84532 '), [84532, 11155111])
})
check('C2c 交易对子集保序', () => {
  assert.deepEqual(parsePairs('ETH/USDT,BTC/USDT'), ['ETH/USDT', 'BTC/USDT'])
  assert.deepEqual(parsePairs('TKA/TKB'), ['TKA/TKB'])
})

// C3 显式设置但为空 / 含空项 → 抛错（失败关闭）
check('C3a 整体为空字符串 → 抛错', () => {
  assert.throws(() => parseChains(''), /S4_CHAINS/)
  assert.throws(() => parsePairs(''), /S4_PAIRS/)
  assert.throws(() => parseChains('   '), /S4_CHAINS/)
})
check('C3b 含空项（双逗号 / 结尾逗号）→ 抛错', () => {
  assert.throws(() => parseChains('11155111,,84532'), /S4_CHAINS/)
  assert.throws(() => parseChains('11155111,'), /S4_CHAINS/)
  assert.throws(() => parsePairs('BTC/USDT,,ETH/USDT'), /S4_PAIRS/)
})

// C4 白名单外 → 抛错
check('C4a 未知链 id / 非数字 → 抛错', () => {
  assert.throws(() => parseChains('1'), /S4_CHAINS/)
  assert.throws(() => parseChains('abc'), /S4_CHAINS/)
  assert.throws(() => parseChains('11155111,1'), /S4_CHAINS/)
})
check('C4b 未登记交易对 → 抛错', () => {
  assert.throws(() => parsePairs('FOO/BAR'), /S4_PAIRS/)
  assert.throws(() => parsePairs('BTC/USDT,FOO/BAR'), /S4_PAIRS/)
})

// C5 代表对规则（两处调用点共用）
check('C5a 缺省全集 → DEFAULT_PAIR', () => {
  assert.equal(pickCheckPair({ pairs: parsePairs(undefined) }), DEFAULT_PAIR)
  assert.equal(DEFAULT_PAIR, 'BTC/USDT')
})
check('C5b 子集含 DEFAULT_PAIR（非首位）→ 仍用 DEFAULT_PAIR', () => {
  assert.equal(pickCheckPair({ pairs: ['ETH/USDT', 'BTC/USDT'] }), 'BTC/USDT')
})
check('C5c 子集不含 DEFAULT_PAIR → 子集首对，绝不落到子集外', () => {
  assert.equal(pickCheckPair({ pairs: ['ETH/USDT', 'SOL/USDT'] }), 'ETH/USDT')
  assert.equal(pickCheckPair({ pairs: parsePairs('SOL/USDT') }), 'SOL/USDT')
})

if (failures > 0) {
  console.error(`\n${failures} 个场景失败`)
  process.exit(1)
}
console.log('\n全部配置解析场景通过')
