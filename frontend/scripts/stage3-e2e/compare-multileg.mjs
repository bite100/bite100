#!/usr/bin/env node
/**
 * 第 43 轮块 A 对账：读节点路径与前端路径的多腿结果 JSON，逐项比对并
 * 输出对账表（markdown）。任一硬断言失败以非零码退出。
 *
 * 口径（与 D1 compare.mjs 同源，扩展到多腿）：
 * 1) 腿级对账（核心）：每场景的撮合腿序列（maker/taker/量/价/额）、
 *    实际成交腿、陈旧腿、余量——两路径逐字相等。
 * 2) 累计量：全部共享订单的链上 filledIn/Out 账本逐字相等，并对
 *    关键订单断言绝对值（由场景设计直接算出）。
 * 3) 手续费：按腿重算 feeIn/feeOut（0.01%）与开发者 1% 分账
 *    （FeeDistributor.receiveFee 逐笔 floor(fee/100)），两路径相等
 *    且与链上 FD/开发者余额逐字对上。
 * 4) gas 对半：逐事件校验份额恒等——(makerDeduct+makerShortfall)
 *    与 (takerDeduct+takerShortfall) 按本腿成交价换算等值（容差
 *    ≤4 wei）；S1/S2/S3 金额足够大，断言 shortfall=0；S5 微腿在
 *    10% 扣减封顶下 shortfall 非零属合约预期行为，只做恒等校验。
 *    跨路径计量 gasUsed 只报告差额（入口计量范围不同，D1 同口径）。
 * 5) 净额分解：用各路径自己的 gas 事件重算四方 Vault 余额并与链上
 *    读数逐字比对（每条路径内部自洽），跨路径余额差应恰等于跨路径
 *    gas 扣减差——由 1)+3)+5) 联合保证，此处只做逐路径自洽断言。
 * 6) nonce 消耗（第 62 轮起位图口径）：nonces 字段为 nonceBitmap 的
 *    word 0。两路分配均为从 0 起顺序发放，消耗 n 枚 ⇔ word0 = 2^n − 1：
 *    节点路径 {maker 55, taker 4, owner 1} 枚；前端路径因单方场景 S4
 *    多消耗 maker 60 / taker 4 两枚，为 {61, 5, 1} 枚，差额恰为 S4，
 *    逐项按 2^n − 1 断言并注明。
 */
import { readFileSync } from 'node:fs'

const [nodePath, fePath] = process.argv.slice(2)
const N = JSON.parse(readFileSync(nodePath, 'utf8'))
const F = JSON.parse(readFileSync(fePath, 'utf8'))
// Go 端空切片序列化为 null，归一化为 []（前端 JSON 恒为数组）
for (const res of [N, F]) {
  for (const sc of res.scenarios) {
    sc.legs = sc.legs ?? []
    sc.settledLegs = sc.settledLegs ?? []
    sc.staleLegs = sc.staleLegs ?? []
    sc.gasEvents = sc.gasEvents ?? []
  }
}
// 前端单方场景 S4 也真实结算了一腿（ml-x1），其手续费/gas/余额影响
// 必须计入前端路径的重算；跨路径比较时以此腿为已知差额扣除。
if (F.s4Expiry && F.s4Expiry.gasEvent) {
  F.scenarios.push({
    name: 'S4-expiry-prune-feonly',
    legs: [],
    settledLegs: [{
      makerOrderId: 'ml-x1', takerOrderId: 'ml-t5',
      qtyToken0: '10000000000000000000', priceWei: '2000000000000000000',
      quoteAmount: '20000000000000000000',
    }],
    staleLegs: [],
    remainderToken0: '0',
    gasEvents: [F.s4Expiry.gasEvent],
    settleGasUsedTotal: '0',
  })
}
const E18 = 10n ** 18n
let failures = 0
const rows = []
function check(name, ok, detail) {
  rows.push(`| ${name} | ${ok ? '✓ 成立' : '✗ 不符'} | ${detail} |`)
  if (!ok) failures += 1
}
const eq = (a, b) => String(a) === String(b)
const jeq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const T = (n) => (BigInt(n) * E18).toString()

// 前置一致性
check('部署地址（五合约）',
  ['tokenA', 'tokenB', 'vault', 'feeDistributor', 'settlement'].every((k) => eq(N.addresses[k], F.addresses[k])),
  `Settlement ${N.addresses.settlement}`)
const sharedOrders = Object.keys(N.orders)
check(`订单摘要（${sharedOrders.length} 单共享）`,
  sharedOrders.every((id) => F.orders[id] && eq(N.orders[id], F.orders[id])),
  'maker/taker/oc/55 档逐单同值')

// 1) 腿级对账
const scN = Object.fromEntries(N.scenarios.map((s) => [s.name, s]))
const scF = Object.fromEntries(F.scenarios.map((s) => [s.name, s]))
for (const name of ['S1-multilevel', 'S2-partial-remainder', 'S3-stale-leg', 'S5-leg-cap']) {
  const a = scN[name]
  const b = scF[name]
  check(`${name} 撮合腿序列（${a.legs.length} 腿）`, jeq(a.legs, b.legs),
    a.legs.map((l) => `${l.makerOrderId}:${l.qtyToken0}@${l.priceWei}`).join(' ') || '—')
  check(`${name} 实际成交腿（${a.settledLegs.length} 腿）`, jeq(a.settledLegs, b.settledLegs),
    `成交 ${a.settledLegs.length} / 撮合 ${a.legs.length}`)
  check(`${name} 陈旧腿`, jeq(a.staleLegs, b.staleLegs),
    a.staleLegs.length ? a.staleLegs.map((l) => l.makerOrderId).join(',') : '无')
  check(`${name} 未成交余量`, eq(a.remainderToken0, b.remainderToken0), `${a.remainderToken0} wei`)
}

// 2) 累计量账本
check('链上累计成交账本（共享订单 filledIn/Out）',
  sharedOrders.every((id) => jeq(N.filled[id], F.filled[id])),
  `${sharedOrders.length} 单逐字一致`)
const spot = {
  'ml-m1': [40, 80], 'ml-m2': [50, 105], 'ml-m3': [60, 132], 'ml-m4': [10, 20], 'ml-m5': [10, 21],
  'ml-t4': [50, 100], 'ml-c00': [1, 2], 'ml-c49': [1, 2], 'ml-c50': [0, 0], 'ml-c54': [0, 0],
}
const spotOk = Object.entries(spot).every(([id, [i, o]]) => eq(N.filled[id].in, T(i)) && eq(N.filled[id].out, T(o)))
check('关键订单累计量绝对值（m1..m5/t4/c00/c49 成交、c50/c54 零成交）', spotOk,
  `m3=${N.filled['ml-m3'].in}/${N.filled['ml-m3'].out} t4=${N.filled['ml-t4'].in} c50=${N.filled['ml-c50'].in}`)
check('taker 累计成交量（t1=120 / t2=30 / t3=10 / oc=10）',
  eq(N.filled['ml-t1'].in, T(120)) && eq(N.filled['ml-t2'].in, T(30)) &&
  eq(N.filled['ml-t3'].in, T(10)) && eq(N.filled['ml-oc'].in, T(10)),
  `t1 ${N.filled['ml-t1'].in} / t2 ${N.filled['ml-t2'].in} / t3 ${N.filled['ml-t3'].in}`)

// 3) 手续费与分账（按腿重算）
function feeSums(res) {
  let feeA = 0n, feeB = 0n, devA = 0n, devB = 0n
  for (const sc of res.scenarios) {
    for (const leg of sc.settledLegs) {
      const fIn = BigInt(leg.qtyToken0) / 10000n
      const fOut = BigInt(leg.quoteAmount) / 10000n
      feeA += fIn; feeB += fOut
      devA += fIn / 100n; devB += fOut / 100n
    }
  }
  return { feeA, feeB, devA, devB }
}
for (const [res, label] of [[N, '节点'], [F, '前端']]) {
  const { feeA, feeB, devA, devB } = feeSums(res)
  check(`手续费与 99/1 分账（${label}路径重算对链上）`,
    eq((BigInt(res.feeDistributor.a) + BigInt(res.developer.a)).toString(), feeA.toString()) &&
    eq((BigInt(res.feeDistributor.b) + BigInt(res.developer.b)).toString(), feeB.toString()) &&
    eq(res.developer.a, devA.toString()) && eq(res.developer.b, devB.toString()) &&
    eq(res.feeDistributor.a, (feeA - devA).toString()) && eq(res.feeDistributor.b, (feeB - devB).toString()),
    `feeA ${feeA} / feeB ${feeB} wei；dev A ${devA} / B ${devB}`)
}
{
  // 跨路径手续费一致性：前端路径多结算了单方场景 S4 的一腿（ml-x1），
  // 其费用（feeIn 1e15 / feeOut 2e15，dev 分账 1e13 / 2e13）为已知差额，
  // 扣除后两路径 FD/开发者四项应逐字相等。
  const dA = 1000000000000000n, dB = 2000000000000000n
  const ddA = 10000000000000n, ddB = 20000000000000n
  const okCross =
    eq((BigInt(F.feeDistributor.a) + BigInt(F.developer.a) - dA).toString(), (BigInt(N.feeDistributor.a) + BigInt(N.developer.a)).toString()) &&
    eq((BigInt(F.feeDistributor.b) + BigInt(F.developer.b) - dB).toString(), (BigInt(N.feeDistributor.b) + BigInt(N.developer.b)).toString()) &&
    eq((BigInt(F.developer.a) - ddA).toString(), N.developer.a) &&
    eq((BigInt(F.developer.b) - ddB).toString(), N.developer.b) &&
    eq((BigInt(F.feeDistributor.a) - (dA - ddA)).toString(), N.feeDistributor.a) &&
    eq((BigInt(F.feeDistributor.b) - (dB - ddB)).toString(), N.feeDistributor.b)
  check('手续费跨路径一致（扣前端单方 S4 一腿费用后）', okCross,
    `S4 差额 feeIn ${dA} / feeOut ${dB} wei`)
}

// 4) gas 对半（逐事件份额恒等）+ 5) 净额分解
function gasAndNet(res, label) {
  let halvesOk = true
  let shortOk = true
  let evCount = 0
  // 净额分解累加器
  let makerQty = 0n, makerQuote = 0n, makerFeeOut = 0n, makerDeductB = 0n
  let takerQty = 0n, takerQuote = 0n, takerFeeIn = 0n, takerDeductA = 0n
  let ocQty = 0n, ocFeeIn = 0n, ocDeductA = 0n
  for (const sc of res.scenarios) {
    if (sc.gasEvents.length !== sc.settledLegs.length) {
      halvesOk = false
      rows.push(`| gas 事件数（${label}/${sc.name}） | ✗ 不符 | events ${sc.gasEvents.length} vs settled ${sc.settledLegs.length} |`)
      failures += 1
      continue
    }
    sc.settledLegs.forEach((leg, i) => {
      const ev = sc.gasEvents[i]
      evCount += 1
      const mShare = BigInt(ev.makerDeduct) + BigInt(ev.makerShortfall)
      const tShare = BigInt(ev.takerDeduct) + BigInt(ev.takerShortfall)
      const qty = BigInt(leg.qtyToken0)
      const quote = BigInt(leg.quoteAmount)
      const diff = mShare * qty > tShare * quote ? mShare * qty - tShare * quote : tShare * quote - mShare * qty
      if (ev.reason !== '0' || diff > 4n * qty) halvesOk = false
      if (sc.name !== 'S5-leg-cap' && (ev.makerShortfall !== '0' || ev.takerShortfall !== '0')) shortOk = false
      const fIn = qty / 10000n
      const fOut = quote / 10000n
      makerQty += qty; makerQuote += quote; makerFeeOut += fOut; makerDeductB += BigInt(ev.makerDeduct)
      if (leg.takerOrderId === 'ml-oc') {
        ocQty += qty; ocFeeIn += fIn; ocDeductA += BigInt(ev.takerDeduct)
      } else {
        takerQty += qty; takerQuote += quote; takerFeeIn += fIn; takerDeductA += BigInt(ev.takerDeduct)
      }
    })
  }
  check(`gas 对半份额恒等（${label}路径，${evCount} 事件）`, halvesOk,
    '逐事件 (扣减+shortfall) 两侧按腿价换算等值，reason=OK')
  check(`gas shortfall=0（${label}路径 S1/S2/S3）`, shortOk, 'S5 微腿封顶 shortfall 单独记录，不在此断言')
  const exp = {
    makerA: BigInt(res.deposits.makerA) - makerQty,
    makerB: makerQuote - makerFeeOut - makerDeductB,
    takerA: takerQty - takerFeeIn - takerDeductA,
    takerB: BigInt(res.deposits.takerB) - takerQuote,
    ownerA: ocQty - ocFeeIn - ocDeductA,
    ownerB: BigInt(res.deposits.ownerB) - 21n * E18,
  }
  const netOk = Object.entries(exp).every(([k, v]) => eq(res.vault[k], v.toString()))
  check(`Vault 净额分解自洽（${label}路径）`, netOk,
    Object.entries(exp).map(([k, v]) => `${k}=${res.vault[k]}${eq(res.vault[k], v.toString()) ? '' : `(期望 ${v})`}`).join(' '))
  return evCount
}
gasAndNet(N, '节点')
gasAndNet(F, '前端')
const gasDeltaNote = ['S1-multilevel', 'S2-partial-remainder', 'S3-stale-leg', 'S5-leg-cap']
  .map((n) => `${n}: 节点 ${scN[n].settleGasUsedTotal} / 前端 ${scF[n].settleGasUsedTotal}`).join('；')
rows.push(`| 计量 gasUsed 跨路径差（入口计量范围不同，仅报告） | — | ${gasDeltaNote} |`)

// 6) nonce 消耗（位图口径：nonces = nonceBitmap word 0；从 0 顺序
// 消耗 n 枚 ⇔ word0 = 2^n − 1，期望值按此换算，枚数注在文案里）
check('nonce 消耗位图（节点路径，55/4/1 枚）',
  eq(N.nonces.maker, '36028797018963967') && eq(N.nonces.taker, '15') && eq(N.nonces.owner, '1'),
  `word0 maker ${N.nonces.maker} / taker ${N.nonces.taker} / owner ${N.nonces.owner}`)
check('nonce 消耗位图（前端路径，含单方 S4 的 +6/+1，为 61/5/1 枚）',
  eq(F.nonces.maker, '2305843009213693951') && eq(F.nonces.taker, '31') && eq(F.nonces.owner, '1'),
  `word0 maker ${F.nonces.maker} / taker ${F.nonces.taker} / owner ${F.nonces.owner}；差额恰为 S4 的 x1(60)/t5(4)`)

// 前端单方断言回显
check('S5 合约硬顶（51 腿 staticCall revert）', typeof F.s5CapRevert === 'string' && F.s5CapRevert.length > 0,
  (F.s5CapRevert || '').slice(0, 90))
check('S4 过期腿剔除（前端单方自断言）',
  F.s4Expiry && F.s4Expiry.selfCheck === 'passed' && F.s4Expiry.prunedMakerOrderId === 'ml-x2' &&
  eq(F.filled['ml-x1'].in, T(10)) && eq(F.filled['ml-x2'].in, '0'),
  F.s4Expiry ? `剔除 ${F.s4Expiry.prunedMakerOrderId}（${(F.s4Expiry.prunedReason || '').slice(0, 60)}）` : '缺失')

console.log('| 对账项 | 结果 | 明细 |')
console.log('|---|---|---|')
for (const r of rows) console.log(r)
console.log(failures === 0 ? '\n对账结论：全部通过。' : `\n对账结论：${failures} 项不符。`)
process.exit(failures === 0 ? 0 : 1)
