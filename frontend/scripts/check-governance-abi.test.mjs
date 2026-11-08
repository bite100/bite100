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

for (const [name, content] of Object.entries(mustFailFixtures)) {
  expectFail(name, content, stubArtifact)
}

if (hasRealArtifact) {
  expectFail('mixedBogus', mixedBogus, realArtifact)
  for (const [name, content] of Object.entries(mustPassFixtures)) {
    expectPass(name, content)
  }
  const r = runChecker(realConfig, realArtifact)
  if (r.status !== 0) {
    failed++
    console.error(`自检失败：正例（真实 config.ts）未通过主检查\n${r.stdout}\n${r.stderr}`)
  } else {
    console.log('自检通过：正例（真实 config.ts）通过主检查')
  }
} else {
  console.log('自检跳过产物相关用例（mixedBogus 与三个引号正例、真实 config 正例）：forge 产物不存在（CI 在 forge build 后运行，自检时会带上）')
}

if (failed > 0) {
  console.error(`ABI 检查自检失败：${failed} 项未达预期`)
  process.exit(1)
}
console.log('ABI 检查自检全部通过')
