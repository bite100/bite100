#!/usr/bin/env node
// 第 34 轮 M2：check-governance-abi.mjs 的负例自检。
//
// 背景：主检查旧实现以单引号正则抓 GOVERNANCE_ABI 声明，config.ts
// 引号风格变化或数组清空时会解析到 0 条并以「0 条一致」空过。本自检
// 用三份假 config 证明加固后的主检查必定报错：
//   1. 空 ABI（数组无任何声明）
//   2. 双引号形式（声明改用双引号）
//   3. 不可解析的声明（单引号但非合法签名）
// 并在 forge 产物存在时跑一遍真实 config 的正例（应通过）。
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

// 负例与比对无关：产物用真实 artifact（若有）或空 abi 的桩件——加固
// 点都在解析阶段触发，与产物内容无关。
let artifactPath = realArtifact
if (!existsSync(realArtifact)) {
  artifactPath = join(dir, 'artifact.json')
  writeFileSync(artifactPath, JSON.stringify({ abi: [] }))
}

const fixtures = {
  empty: `export const GOVERNANCE_ABI = [\n] as const\n`,
  doubleQuoted: `export const GOVERNANCE_ABI = [\n  "function proposalCount() view returns (uint256)",\n] as const\n`,
  unparseable: `export const GOVERNANCE_ABI = [\n  'this is not a signature',\n] as const\n`,
}

function runChecker(configPath) {
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
for (const [name, content] of Object.entries(fixtures)) {
  const p = join(dir, `${name}.ts`)
  writeFileSync(p, content)
  const r = runChecker(p)
  if (r.status === 0) {
    failed++
    console.error(`自检失败：负例 ${name} 被主检查放行（退出码 0）`)
  } else {
    console.log(`自检通过：负例 ${name} 被主检查拦下（退出码 ${r.status}）`)
  }
}

if (existsSync(realArtifact)) {
  const r = runChecker(realConfig)
  if (r.status !== 0) {
    failed++
    console.error(`自检失败：正例（真实 config.ts）未通过主检查\n${r.stdout}\n${r.stderr}`)
  } else {
    console.log('自检通过：正例（真实 config.ts）通过主检查')
  }
} else {
  console.log('自检跳过正例：forge 产物不存在（CI 在 forge build 后运行，自检时会带正例）')
}

if (failed > 0) {
  console.error(`ABI 检查自检失败：${failed} 项未达预期`)
  process.exit(1)
}
console.log('ABI 检查自检全部通过')
