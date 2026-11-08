#!/usr/bin/env node
// 第 34 轮 M2：check-governance-abi.mjs 的负例自检。
// 第 35 轮 M2-R：主检查的提取层改为三引号全覆盖扫描后，自检口径随之
// 更新——双引号/反引号的纯字符串声明从此是合法形式（正例），新增的
// 负例针对「漏检」与「非纯元素」两类静默放行：
//
// 必拦（与产物无关，解析/提取阶段就失败，或计数正确时必然漂移）：
//   1. empty              空 ABI（0 条声明）
//   2. unparseable        单引号但非合法签名
//   3. templateExpression 反引号里含 ${...} 模板表达式
//   4. expressionElement  数组元素是标识符表达式（非纯字符串）
//   5. mixedBogus         混合引号数组里藏一条反引号伪造声明——只有
//                         提取层真把反引号计入时才会因漂移被拦；
//                         若漏检，该伪造条被跳过、其余条目对齐产物，
//                         检查会错误放行——本例即为此设
// 必过（需真实 forge 产物在场；无产物时跳过并注明）：
//   6. doubleQuoted       真实签名改用双引号（第 35 轮起合法）
//   7. backtickPlain      真实签名改用反引号模板字符串（纯字面量）
//   8. mixedQuotes        三种引号混排的真实签名
// 并在产物存在时跑一遍真实 config 的正例（应通过）。
//
// 第 36 轮 N2 新增（词法结尾检测；均需真实产物）：
//   9. commentLineLegit   数组内一行 // ] as const 注释，后接第二条
//                         合法声明 → 必过，且通过信息须报 2 条声明
//                         （计数证明两条都被提取、没有静默截断）
//  10. commentBlockLegit  块注释 /* ] as const */ 变体 → 同上
//  11. commentLineForged  注释伪结尾后放一条伪造声明 → 必因漂移被拦
//                         （被拦即证明该声明被提取并参与比对）
//  12. commentBlockForged 块注释变体 → 同上
//
// 用法：仓库根目录或 frontend/ 下 `node frontend/scripts/
// check-governance-abi.test.mjs`，或 frontend 内
// `npm run check:abi:selftest`。零依赖，纯 Node。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const checker = join(here, 'check-governance-abi.mjs')
const realArtifact = join(repoRoot, 'contracts/out/Governance.sol/Governance.json')
const realConfig = join(repoRoot, 'frontend/src/config.ts')

const dir = mkdtempSync(join(tmpdir(), 'abi-check-selftest-'))
const hasRealArtifact = existsSync(realArtifact)

// 负例与比对无关时用空 abi 桩件：empty/unparseable/templateExpression/
// expressionElement 都在提取阶段触发；mixedBogus 需要真实产物才能
// 证明「计数正确 ⇒ 必因漂移被拦」，无产物时改用真实产物缺失的说明跳过。
const stubArtifact = join(dir, 'artifact.json')
writeFileSync(stubArtifact, JSON.stringify({ abi: [] }))

const SIG_COUNT = 'function proposalCount() view returns (uint256)'
const SIG_VOTE = 'function vote(uint256 proposalId, bool support, bytes32[] calldata proof)'
const SIG_EXECUTED = 'event ProposalExecuted(uint256 indexed proposalId)'

const mustFailFixtures = {
  empty: `export const GOVERNANCE_ABI = [\n] as const\n`,
  unparseable: `export const GOVERNANCE_ABI = [\n  'this is not a signature',\n] as const\n`,
  templateExpression:
    'export const GOVERNANCE_ABI = [\n  `function proposal${"Count"}() view returns (uint256)`,\n] as const\n',
  expressionElement: `export const GOVERNANCE_ABI = [\n  SOME_IMPORTED_SIG,\n] as const\n`,
}

const mixedBogus =
  `export const GOVERNANCE_ABI = [\n  '${SIG_COUNT}',\n` +
  '  `function notInContract() view returns (uint256)`,\n] as const\n'

const mustPassFixtures = {
  doubleQuoted: `export const GOVERNANCE_ABI = [\n  "${SIG_COUNT}",\n] as const\n`,
  backtickPlain:
    'export const GOVERNANCE_ABI = [\n  `' + SIG_COUNT + '`,\n] as const\n',
  mixedQuotes:
    `export const GOVERNANCE_ABI = [\n  '${SIG_COUNT}',\n  "${SIG_VOTE}",\n` +
    '  `' + SIG_EXECUTED + '`,\n] as const\n',
}

// 第 36 轮 N2：注释伪结尾夹具。旧 indexOf('] as const') 结尾定位会被
// 第一条声明后的注释误截断；新词法扫描必须越过注释、数全两条。
const SIG_FORGED = 'function notInContract() view returns (uint256)'
const commentLegitFixtures = {
  commentLineLegit:
    `export const GOVERNANCE_ABI = [\n  '${SIG_COUNT}',\n  // ] as const\n  '${SIG_VOTE}',\n] as const\n`,
  commentBlockLegit:
    `export const GOVERNANCE_ABI = [\n  '${SIG_COUNT}',\n  /* ] as const */\n  '${SIG_VOTE}',\n] as const\n`,
}
const commentForgedFixtures = {
  commentLineForged:
    `export const GOVERNANCE_ABI = [\n  '${SIG_COUNT}',\n  // ] as const\n  '${SIG_FORGED}',\n] as const\n`,
  commentBlockForged:
    `export const GOVERNANCE_ABI = [\n  '${SIG_COUNT}',\n  /* ] as const */\n  '${SIG_FORGED}',\n] as const\n`,
}

// 第 37 轮词法边界夹具：模板表达式 ${/}/} 必被具名错误拦下（负例，
// 用桩件即可——findArrayEnd 阶段即失败）；普通字符串内的正则字样
// 必过（正例，需真实产物比对）；未闭合模板必失败（EOF 扫描不归零）。
const tplRegexExprFixture =
  'export const GOVERNANCE_ABI = [\n  `function x() ${/}/.test(y)}`,\n] as const\n'
const unterminatedTplFixture =
  'export const GOVERNANCE_ABI = [\n  `function proposalCount() view returns (uint256),\n] as const\n'
const regexInStringFixture =
  `export const GOVERNANCE_ABI = [\n  '${SIG_COUNT}', // pattern /}/ inside a plain string is inert: '/}/'\n] as const\n`

function runChecker(configPath, artifactPath) {
  return spawnSync(process.execPath, [checker], {
    env: {
      ...process.env,
      GOVERNANCE_ABI_CONFIG_PATH: configPath,
      GOVERNANCE_ABI_ARTIFACT_PATH: artifactPath,
    },
    encoding: 'utf8',
  })
}

let failed = 0
function expectFail(name, content, artifactPath) {
  const p = join(dir, `${name}.ts`)
  writeFileSync(p, content)
  const r = runChecker(p, artifactPath)
  if (r.status === 0) {
    failed++
    console.error(`自检失败：负例 ${name} 被主检查放行（退出码 0）`)
  } else {
    console.log(`自检通过：负例 ${name} 被主检查拦下（退出码 ${r.status}）`)
  }
}
function expectPass(name, content) {
  const p = join(dir, `${name}.ts`)
  writeFileSync(p, content)
  const r = runChecker(p, realArtifact)
  if (r.status !== 0) {
    failed++
    console.error(`自检失败：正例 ${name} 未通过主检查\n${r.stdout}\n${r.stderr}`)
  } else {
    console.log(`自检通过：正例 ${name} 通过主检查`)
  }
}
// 正例 + 声明计数断言：主检查是「前端 ⊆ 产物」的子集口径，单看退出码
// 无法区分「两条都提取」与「第二条被截断、只剩一条也对齐」——必须核
// 通过信息里的声明总数（N2 防静默截断的计数证明）。
function expectPassCount(name, content, n) {
  const p = join(dir, `${name}.ts`)
  writeFileSync(p, content)
  const r = runChecker(p, realArtifact)
  if (r.status !== 0) {
    failed++
    console.error(`自检失败：正例 ${name} 未通过主检查\n${r.stdout}\n${r.stderr}`)
  } else if (!r.stdout.includes(`${n} 条声明`)) {
    failed++
    console.error(`自检失败：正例 ${name} 通过但声明计数不是 ${n} 条（疑似静默截断）\n${r.stdout}`)
  } else {
    console.log(`自检通过：正例 ${name} 通过主检查且计数 = ${n} 条声明`)
  }
}

for (const [name, content] of Object.entries(mustFailFixtures)) {
  expectFail(name, content, stubArtifact)
}
// 第 37 轮：模板表达式（含正则字样 ${/}/}）与未闭合模板——提取阶段即失败，桩件足够
expectFail('tplRegexExpr', tplRegexExprFixture, stubArtifact)
expectFail('unterminatedTpl', unterminatedTplFixture, stubArtifact)

if (hasRealArtifact) {
  expectFail('mixedBogus', mixedBogus, realArtifact)
  for (const [name, content] of Object.entries(mustPassFixtures)) {
    expectPass(name, content)
  }
  for (const [name, content] of Object.entries(commentLegitFixtures)) {
    expectPassCount(name, content, 2)
  }
  for (const [name, content] of Object.entries(commentForgedFixtures)) {
    expectFail(name, content, realArtifact)
  }
  // 第 37 轮：普通字符串字面量内的正则字样不触发模板表达式失败
  expectPass('regexInString', regexInStringFixture)
  const r = runChecker(realConfig, realArtifact)
  if (r.status !== 0) {
    failed++
    console.error(`自检失败：正例（真实 config.ts）未通过主检查\n${r.stdout}\n${r.stderr}`)
  } else {
    console.log('自检通过：正例（真实 config.ts）通过主检查')
  }
} else {
  console.log('自检跳过产物相关用例（mixedBogus、引号正例、N2 注释伪结尾四例、真实 config 正例）：forge 产物不存在（CI 在 forge build 后运行，自检时会带上）')
}

if (failed > 0) {
  console.error(`ABI 检查自检失败：${failed} 项未达预期`)
  process.exit(1)
}
console.log('ABI 检查自检全部通过')
