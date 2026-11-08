#!/usr/bin/env node
// 第 33 轮落地：治理 ABI 防漂移检查（轻量版）。
//
// 背景：第 32 轮修复的治理 ABI 漂移（getProposal 缺 executableAt、
// getMultiStepProposal 缺失、下标错位）源于 frontend/src/config.ts 的
// GOVERNANCE_ABI 全手写、无任何自动核对。本脚本把 config.ts 中声明的
// 每条 function/event 签名与 forge 产物（contracts/out/Governance.sol/
// Governance.json）的规范 ABI 逐条比对（名称 + 输入类型 + 输出类型 +
// view/pure 属性 + event indexed 位图），任一不一致即非零退出。
//
// 只做「前端声明 ⊆ 合约产物且签名精确一致」方向：前端按需声明子集是
// 合法的，合约多出未声明函数不算漂移；前端声明了合约没有的、或字段
// 顺序/类型对不上的，才是第 32 轮那种漂移。
//
// 用法：先在 contracts/ 跑 `forge build` 产出 artifact，再在仓库根目录
// 或 frontend/ 下跑 `node frontend/scripts/check-governance-abi.mjs`
// （或 frontend 内 `npm run check:abi`）。CI 接在 contracts.yml 的
// forge build 之后。零依赖，纯 Node。
//
// 第 34 轮 M2 加固：解析为空过防护——旧实现以单引号正则抓声明，若
// config.ts 的引号风格变化（如改双引号）或数组被清空，正则抓到 0 条、
// 循环不执行、检查会以「0 条一致」空过。现行口径：双引号声明直接报错；
// 单引号声明数为 0 直接报错；任一声明解析失败直接报错；通过时声明
// 总数 = 实际比对数。自检：`npm run check:abi:selftest`（负例为空 ABI
// 与双引号形式）。路径可用环境变量 GOVERNANCE_ABI_CONFIG_PATH /
// GOVERNANCE_ABI_ARTIFACT_PATH 覆盖（自检用）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const artifactPath = process.env.GOVERNANCE_ABI_ARTIFACT_PATH || join(repoRoot, 'contracts/out/Governance.sol/Governance.json')
const configPath = process.env.GOVERNANCE_ABI_CONFIG_PATH || join(repoRoot, 'frontend/src/config.ts')

// 把单个参数声明归一化为 { type, indexed }：去掉数据位置标注与参数名。
// 例："bytes32[] calldata proof" -> { type: "bytes32[]", indexed: false }
//     "uint256 indexed proposalId" -> { type: "uint256", indexed: true }
function normalizeParam(raw) {
  const tokens = raw.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  const type = tokens[0]
  const indexed = tokens.includes('indexed')
  return { type, indexed }
}

function splitParams(list) {
  const inner = list.trim()
  if (!inner) return []
  return inner.split(',').map(normalizeParam).filter(Boolean)
}

// 解析前端人类可读签名：
// "function getProposal(uint256 proposalId) view returns (address target, ...)"
// "event Voted(uint256 indexed proposalId, ...)"
function parseFrontendSig(sig) {
  const m = sig.match(/^(function|event)\s+(\w+)\(([^)]*)\)\s*(.*)$/)
  if (!m) throw new Error(`无法解析前端签名: ${sig}`)
  const [, kind, name, inputsRaw, rest] = m
  const inputs = splitParams(inputsRaw)
  let outputs = []
  let mutability = ''
  if (kind === 'function') {
    if (/\bview\b/.test(rest)) mutability = 'view'
    else if (/\bpure\b/.test(rest)) mutability = 'pure'
    const r = rest.match(/returns\s*\(([^)]*)\)/)
    if (r) outputs = splitParams(r[1])
  }
  return { kind, name, inputs, outputs, mutability }
}

// 从 forge artifact 的一条 ABI 构造同口径结构。
function fromArtifact(entry) {
  const kind = entry.type === 'event' ? 'event' : 'function'
  return {
    kind,
    name: entry.name,
    inputs: (entry.inputs || []).map((i) => ({ type: i.type, indexed: !!i.indexed })),
    outputs: (entry.outputs || []).map((o) => ({ type: o.type, indexed: false })),
    mutability: kind === 'function' ? (entry.stateMutability === 'view' || entry.stateMutability === 'pure' ? entry.stateMutability : '') : '',
  }
}

function sigKey(s) {
  const ins = s.inputs.map((p) => `${p.type}${p.indexed ? ' indexed' : ''}`).join(',')
  const outs = s.outputs.map((p) => p.type).join(',')
  return `${s.kind} ${s.name}(${ins}) ${s.mutability} returns (${outs})`
}

// 去掉块内的 // 行注释（跟踪单引号状态，引号内的 // 不处理；本仓库
// 的人类可读签名不含斜杠）。注释里可能出现引号，不剔除会污染声明计数。
function stripLineComments(text) {
  return text.split('\n').map((line) => {
    let inQuote = false
    for (let i = 0; i < line.length - 1; i++) {
      if (line[i] === "'") inQuote = !inQuote
      if (!inQuote && line[i] === '/' && line[i + 1] === '/') return line.slice(0, i)
    }
    return line
  }).join('\n')
}

// 从 config.ts 的 GOVERNANCE_ABI 数组块提取并解析全部声明（M2 加固点）：
// 声明总数以块内引号字符串计数为准，任一环节异常都以 exit(1) 失败，
// 绝不允许「解析到 0 条」时空过。
function extractFrontendSigs(configText) {
  const start = configText.indexOf('export const GOVERNANCE_ABI = [')
  if (start < 0) {
    console.error('config.ts 中找不到 GOVERNANCE_ABI')
    process.exit(2)
  }
  const end = configText.indexOf('] as const', start)
  if (end < 0) {
    console.error('config.ts 中 GOVERNANCE_ABI 数组未以 ] as const 结尾')
    process.exit(1)
  }
  const block = stripLineComments(configText.slice(start, end))
  const doubleQuoted = [...block.matchAll(/"([^"]+)"/g)]
  if (doubleQuoted.length > 0) {
    console.error(`GOVERNANCE_ABI 含 ${doubleQuoted.length} 条双引号声明，本检查只认单引号口径——引号风格变化不得让检查空过，请改回单引号或同步升级本脚本`)
    process.exit(1)
  }
  const rawDecls = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1])
  if (rawDecls.length === 0) {
    console.error('GOVERNANCE_ABI 解析到 0 条声明（数组为空或格式已变）——拒绝空过，检查失败')
    process.exit(1)
  }
  const sigs = []
  for (const raw of rawDecls) {
    try {
      sigs.push(parseFrontendSig(raw))
    } catch (e) {
      console.error(`GOVERNANCE_ABI 声明解析失败：${e.message}`)
      process.exit(1)
    }
  }
  if (sigs.length !== rawDecls.length) {
    console.error(`GOVERNANCE_ABI 声明对账失败：块内 ${rawDecls.length} 条、成功解析 ${sigs.length} 条`)
    process.exit(1)
  }
  return sigs
}

function main() {
  let artifact
  try {
    artifact = JSON.parse(readFileSync(artifactPath, 'utf8'))
  } catch {
    console.error(`找不到 forge 产物 ${artifactPath}，请先在 contracts/ 跑 forge build`)
    process.exit(2)
  }
  const artifactSigs = new Map()
  for (const entry of artifact.abi) {
    if (entry.type !== 'function' && entry.type !== 'event') continue
    const s = fromArtifact(entry)
    artifactSigs.set(sigKey(s), s)
  }

  const configText = readFileSync(configPath, 'utf8')
  const frontendSigs = extractFrontendSigs(configText)

  let failed = 0
  for (const fs of frontendSigs) {
    const key = sigKey(fs)
    if (!artifactSigs.has(key)) {
      failed++
      console.error(`漂移: 前端声明与合约产物不一致 -> ${key}`)
      // 给出同名条目的产物签名，便于定位差异
      for (const [k, s] of artifactSigs) {
        if (s.name === fs.name && s.kind === fs.kind) console.error(`      合约产物为 -> ${k}`)
      }
    }
  }
  if (failed > 0) {
    console.error(`GOVERNANCE_ABI 漂移检查失败：${failed}/${frontendSigs.length} 条不一致`)
    process.exit(1)
  }
  console.log(`GOVERNANCE_ABI 漂移检查通过：${frontendSigs.length} 条声明与 forge 产物逐条一致`)
}

main()
