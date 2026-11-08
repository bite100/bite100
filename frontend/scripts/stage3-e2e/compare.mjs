#!/usr/bin/env node
/**
 * 阶段 3 块 D1 对账：读节点路径与前端路径两个结果 JSON，逐项比对并
 * 输出对账表（markdown）。任一硬断言失败以非零码退出。
 *
 * 四项口径：
 * 1) 成交量：qty/quote/filled 账本/nonce —— 必须逐字相等。
 * 2) 价格改善：两路径成交价都必须 = maker 价 2.0（taker 限价 2.5）。
 * 3) gas 对半：第 21 轮规则——同一路径内两侧扣除等值（maker 以 TKB 扣、
 *    taker 以 TKA 扣，按成交价 2.0 换算等值，整数截断容差 ≤2 wei）、
 *    shortfall=0、reason=OK。跨路径计量 gasUsed 允许不同（计量范围是
 *    各自入口函数体：settleTrade vs settleTradesBatch，见轮文档说明），
 *    只报告差额不判失败。
 * 4) FeeDistributor 99/1：开发者得手续费 1%、FD 留存 99%，两路径逐字相等。
 */
import { readFileSync } from 'node:fs'

const [nodePath, fePath] = process.argv.slice(2)
const N = JSON.parse(readFileSync(nodePath, 'utf8'))
const F = JSON.parse(readFileSync(fePath, 'utf8'))
const E18 = 10n ** 18n
let failures = 0
const rows = []
function check(name, ok, detail) {
  rows.push(`| ${name} | ${ok ? '✓ 相等/成立' : '✗ 不符'} | ${detail} |`)
  if (!ok) failures += 1
}
const eq = (a, b) => String(a) === String(b)

// 前置一致性：同部署、同订单
check('部署地址（五合约）',
  ['tokenA', 'tokenB', 'vault', 'feeDistributor', 'settlement'].every((k) => eq(N.addresses[k], F.addresses[k])),
  `Settlement ${N.addresses.settlement}`)
check('订单摘要（maker/taker digest）', eq(N.makerDigest, F.makerDigest) && eq(N.takerDigest, F.takerDigest),
  `maker ${N.makerDigest.slice(0, 18)}…`)

// 1) 成交量
check('成交量 Token0', eq(N.qtyToken0, F.qtyToken0) && eq(N.qtyToken0, (100n * E18).toString()),
  `${N.qtyToken0} wei（100 TKA）`)
check('成交额 Token1（quote）', eq(N.quoteAmount, F.quoteAmount) && eq(N.quoteAmount, (200n * E18).toString()),
  `${N.quoteAmount} wei（200 TKB）`)
check('链上累计成交账本（filledIn/Out ×2 单）',
  JSON.stringify(N.filled) === JSON.stringify(F.filled),
  `makerIn ${N.filled.makerIn} / takerIn ${N.filled.takerIn}`)
check('nonce 消耗（双方各 +1）', JSON.stringify(N.nonces) === JSON.stringify(F.nonces) && eq(N.nonces.maker, '1'),
  `maker ${N.nonces.maker} / taker ${N.nonces.taker}`)

// 2) 价格改善
check('成交价（maker 价 2.0，taker 限价 2.5 → 改善 0.5）',
  eq(N.execPrice, F.execPrice) && eq(N.execPrice, (2n * E18).toString()),
  `两路径均为 ${N.execPrice} wei/TKA`)

check('无 gas 扣减侧余额（maker TKA=0 / taker TKB=800）',
  eq(N.vault.makerA, '0') && eq(F.vault.makerA, '0') &&
  eq(N.vault.takerB, (800n * E18).toString()) && eq(F.vault.takerB, (800n * E18).toString()),
  `makerA ${N.vault.makerA} / takerB ${N.vault.takerB}`)

// 4) 手续费与 99/1（先于 gas 校验：净额分解要用到它）
const feeA = BigInt(N.feeDistributor.a) + BigInt(N.developer.a)
const feeB = BigInt(N.feeDistributor.b) + BigInt(N.developer.b)
check('手续费总额（A 侧 0.01%×100 / B 侧 0.01%×200）',
  eq(feeA.toString(), (E18 / 100n).toString()) && eq(feeB.toString(), (E18 / 50n).toString()) &&
  eq((BigInt(F.feeDistributor.a) + BigInt(F.developer.a)).toString(), feeA.toString()) &&
  eq((BigInt(F.feeDistributor.b) + BigInt(F.developer.b)).toString(), feeB.toString()),
  `A ${feeA} wei / B ${feeB} wei，两路径一致`)
check('FeeDistributor 分账 99/1（开发者 1% 自动到账、FD 留存 99%）',
  eq(N.developer.a, (feeA / 100n).toString()) && eq(N.developer.b, (feeB / 100n).toString()) &&
  eq(F.developer.a, N.developer.a) && eq(F.developer.b, N.developer.b) &&
  eq(N.feeDistributor.a, (feeA - feeA / 100n).toString()) && eq(F.feeDistributor.b, N.feeDistributor.b),
  `dev A ${N.developer.a} / B ${N.developer.b} wei`)

// 3) gas 对半（逐路径校验等值 + 净额分解自洽）
function gasSide(r, label) {
  const g = r.gasEvent
  if (!g) return `${label}: 无 GasCostShared 事件`
  const makerD = BigInt(g.makerDeduct) // TKB
  const takerD = BigInt(g.takerDeduct) // TKA，按成交价 2.0 换算 TKB 价值 = ×2
  const diff = makerD > takerD * 2n ? makerD - takerD * 2n : takerD * 2n - makerD
  const ok = g.reason === '0' && g.makerShortfall === '0' && g.takerShortfall === '0' && diff <= 2n
  // 净额自洽：maker TKB 余额 = 200 − feeB − makerDeduct；taker TKA 余额 = 100 − feeA − takerDeduct
  const makerNet = 200n * E18 - feeB - makerD
  const takerNet = 100n * E18 - feeA - takerD
  const netOk = eq(r.vault.makerB, makerNet.toString()) && eq(r.vault.takerA, takerNet.toString())
  check(`gas 对半（${label}）`, ok && netOk,
    `gasUsed ${g.gasUsed}；maker 扣 ${makerD} TKB-wei / taker 扣 ${takerD} TKA-wei（等值差 ${diff} wei）；净额分解自洽 ${netOk}`)
  return null
}
gasSide(N, '节点路径')
gasSide(F, '前端路径')
const gasDelta = BigInt(N.gasEvent.gasUsed) > BigInt(F.gasEvent.gasUsed)
  ? BigInt(N.gasEvent.gasUsed) - BigInt(F.gasEvent.gasUsed)
  : BigInt(F.gasEvent.gasUsed) - BigInt(N.gasEvent.gasUsed)
rows.push(`| 计量 gasUsed 跨路径差（入口计量范围不同，仅报告） | — | Δ ${gasDelta} gas（节点 ${N.gasEvent.gasUsed} / 前端批 ${F.gasEvent.gasUsed}） |`)

console.log('| 对账项 | 结果 | 明细 |')
console.log('|---|---|---|')
for (const r of rows) console.log(r)
console.log(failures === 0 ? '\n对账结论：四项全过。' : `\n对账结论：${failures} 项不符。`)
process.exit(failures === 0 ? 0 : 1)
