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
// 循环不执行、检查会以「0 条一致」空过。现行口径：声明数为 0 直接
// 报错；任一声明解析失败直接报错；通过时声明总数 = 实际比对数。
// 自检：`npm run check:abi:selftest`。
// 路径可用环境变量 GOVERNANCE_ABI_CONFIG_PATH /
// GOVERNANCE_ABI_ARTIFACT_PATH 覆盖（自检用）。
//
// 第 35 轮 M2-R：混合引号漏检防护——M2 后实现只抓单引号并单独拒绝
// 双引号，反引号模板字符串声明会被提取与计数对账同时漏掉（合法 TS，
// 如数组里混入 `function proposalState(...)`）。首选过 TypeScript
// 编译器 API 走 AST，但实测本仓库的 typescript@^7 主入口只暴露
// version，经典 createSourceFile API 不存在，仅有 unstable/ 预览 API
// ——CI 守卫不骑不稳定的预览 API，故按回退路线实现：块内扫描器覆盖
// 单/双/反引号三种引号（纯字符串字面量一律计数），模板表达式
// (${...})、转义字符、标识符/展开等非纯字符串元素一律报错，绝不
// 静默跳过。自检新增：反引号声明、混合引号、混合中藏伪造声明
// （漏检才会放行）、模板表达式、表达式元素五例。
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

// 扫描 GOVERNANCE_ABI 数组块，提取全部纯字符串字面量声明（M2-R 回退
// 路线：不用正则抓引号，逐字符扫描，引号状态/注释状态都严格跟踪）：
// - 单引号/双引号/反引号三种字面量一律计数（混合风格不漏检）；
// - 反引号里的 ${...} 模板表达式、任一字面量里的反斜杠转义 → 报错
//   （本检查只认纯字面量签名，不猜表达式求值结果）；
// - 字符串之外出现标识符/数字/展开 ... 等非标点内容 → 报错
//   （数组元素不是纯字符串，提取口径不再适用，绝不静默跳过）；
// - // 行注释在非字符串状态下整段跳过（注释里的引号不污染计数）。
function scanStringLiterals(block) {
  const literals = []
  let i = block.indexOf('[')
  if (i < 0) throw new Error('GOVERNANCE_ABI 数组缺少 [')
  i += 1
  let junk = ''
  while (i < block.length) {
    const ch = block[i]
    if (ch === '/' && block[i + 1] === '/') {
      while (i < block.length && block[i] !== '\n') i++
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i++
      let content = ''
      let closed = false
      while (i < block.length) {
        const c = block[i]
        if (c === '\\') {
          throw new Error('GOVERNANCE_ABI 声明含反斜杠转义，本检查只认纯字符串字面量')
        }
        if (quote === '`' && c === '$' && block[i + 1] === '{') {
          throw new Error('GOVERNANCE_ABI 声明含模板表达式 ${...}，本检查只认纯字符串字面量')
        }
        if (c === quote) {
          closed = true
          i++
          break
        }
        content += c
        i++
      }
      if (!closed) throw new Error('GOVERNANCE_ABI 字符串字面量未闭合')
      literals.push(content)
      continue
    }
    if (ch === ',' || ch === ']' || /\s/.test(ch)) {
      i++
      continue
    }
    junk += ch
    i++
  }
  if (junk.trim() !== '') {
    throw new Error(`GOVERNANCE_ABI 数组含非纯字符串元素（残留内容：${junk.trim().slice(0, 40)}），本检查拒绝静默跳过`)
  }
  return literals
}

// 从 config.ts 的 GOVERNANCE_ABI 数组块提取并解析全部声明（M2/M2-R
// 加固点）：任一环节异常都以 exit(1) 失败，绝不允许「解析到 0 条」
// 或「漏检某条」时空过。
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
  const block = configText.slice(start, end)
  let rawDecls
  try {
    rawDecls = scanStringLiterals(block)
  } catch (e) {
    console.error(`GOVERNANCE_ABI 提取失败：${e.message}`)
    process.exit(1)
  }
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
