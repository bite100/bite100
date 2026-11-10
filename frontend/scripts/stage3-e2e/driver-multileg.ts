/**
 * 阶段 3 块 D2 / 第 43 轮块 A：多腿双路对账 E2E —— 前端路径驱动
 * （本地 anvil，绝不连外网）。
 *
 * 与节点路径驱动（node/internal/settlement/e2e_stage3_multileg_test.go）
 * 使用完全相同的部署顺序、账户、订单与价格，跑四个共享场景，结果由
 * compare-multileg.mjs 逐腿对账（腿数/每腿量价/累计量/费用/gas 对半）：
 *
 *   S1 市价买 120 吃三档（40@2.0 / 50@2.1 / 60@2.2 的前 30）
 *   S2 市价买 100 只剩 30 → 成交 30、余量 70 按市价语义取消
 *   S3 陈旧腿：m5 先被另一通道（owner 的 oc 单走 settleTrade 单笔入口）
 *      全量成交，前端撮合仍按旧快照产出两腿 → 生产 prune 预检剔除 m5
 *      腿、批结算只落 m4 腿，与节点路径的逐笔提交失败收敛到同一成交集
 *   S5 腿数触顶：55 档 × 1 TKA → matcher 产 55 腿，capLegs 截断 50、
 *      溢出 5；另以 51 腿整批 staticCall 断言合约 MAX_BATCH_SIZE 硬顶
 *
 * 另含前端单方场景 S4（过期腿剔除）：maker 单在落锁后、结算前过期，
 * prune 剔除过期腿、正常腿照常结算（节点路径无「撮合后过期」的等价
 * 时序，故只在前端路径内自断言，结果写入 s4Expiry 供对账脚本展示）。
 *
 * 本驱动骑生产代码：ORDER_TYPES 签名、dualread/digest 摘要、matching
 * 的 matchTaker / capLegs / simulateAndPrune、fills 的
 * orderDataToContractOrder、SETTLEMENT_ABI / VAULT_LOCK_ABI。
 *
 * 用法（esbuild 打包后）：node driver-multileg.mjs <rpcUrl> <outJson>
 */
import { ethers } from 'ethers'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ORDER_TYPES, type OrderData } from '../../src/services/orderSigningTypes'
import { hashOrderWithDomain } from '../../src/services/dualread/digest'
import { matchTaker, type MatcherOrder } from '../../src/services/matching/matcher'
import { orderDataToContractOrder } from '../../src/services/matching/fills'
import { simulateAndPrune, capLegs } from '../../src/services/matching/prune'
import { SETTLEMENT_ABI } from '../../src/services/settlementAbi'
import { VAULT_LOCK_ABI } from '../../src/services/vaultAbi'
import type { ContractFill } from '../../src/services/settlementService'

const OUT_DIR = process.env.BIT100_CONTRACTS_OUT ?? join(process.cwd(), 'contracts/out')

const OWNER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const MAKER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const TAKER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'
const DEV_ADDR = '0x90F79bf6EB2c4f870365E785982E1f101E93b906'
const E18 = 10n ** 18n
const BASE = 1700000000
const EXP = 2000000000
const tok = (n: bigint) => n * E18

function artifact(name: string) {
  const doc = JSON.parse(readFileSync(join(OUT_DIR, `${name}.sol`, `${name}.json`), 'utf8'))
  return { abi: doc.abi, bytecode: doc.bytecode.object as string }
}

async function deploy(signer: ethers.Signer, name: string, args: unknown[] = []) {
  const a = artifact(name)
  const factory = new ethers.ContractFactory(a.abi, a.bytecode, signer)
  const deployTx = await factory.getDeployTransaction(...args)
  const from = await signer.getAddress()
  const estimated = await signer.provider!.estimateGas({ ...deployTx, from })
  const c = await factory.deploy(...args, { gasLimit: (estimated * 3n) / 2n })
  await c.waitForDeployment()
  return c
}

interface Leg {
  makerOrderId: string
  takerOrderId: string
  qtyToken0: string
  priceWei: string
  quoteAmount: string
}
interface GasEvent {
  gasUsed: string
  reason: string
  makerDeduct: string
  makerShortfall: string
  takerDeduct: string
  takerShortfall: string
}
interface Scenario {
  name: string
  legs: Leg[]
  settledLegs: Leg[]
  staleLegs: Leg[]
  remainderToken0: string
  gasEvents: GasEvent[]
  settleGasUsedTotal: string
}

async function main() {
  const [rpc, outPath] = process.argv.slice(2)
  if (!rpc || !outPath) throw new Error('usage: driver-multileg.mjs <rpc> <outJson>')
  const provider = new ethers.JsonRpcProvider(rpc)
  const owner = new ethers.NonceManager(new ethers.Wallet(OWNER_KEY, provider))
  const maker = new ethers.NonceManager(new ethers.Wallet(MAKER_KEY, provider))
  const taker = new ethers.NonceManager(new ethers.Wallet(TAKER_KEY, provider))
  const ownerAddr = await owner.getAddress()
  const makerAddr = await maker.getAddress()
  const takerAddr = await taker.getAddress()

  // ---- 部署（顺序与节点路径驱动逐字一致 → 地址一致） ----
  const supply = 1000000n * E18
  const tokenA = await deploy(owner, 'MockERC20', ['TokenA', 'TKA', supply])
  const tokenB = await deploy(owner, 'MockERC20', ['TokenB', 'TKB', supply])
  const vault = await deploy(owner, 'Vault')
  const feeDist = await deploy(owner, 'FeeDistributor')
  const settlement = await deploy(owner, 'Settlement', [await vault.getAddress(), await feeDist.getAddress()])
  const chainConfig = await deploy(owner, 'ChainConfig')
  const A = await tokenA.getAddress()
  const B = await tokenB.getAddress()
  const V = await vault.getAddress()
  const FD = await feeDist.getAddress()
  const S = await settlement.getAddress()
  await (await vault.setSettlement(S)).wait()
  await (await settlement.setChainConfig(await chainConfig.getAddress())).wait()
  await (await chainConfig.setQuotePricing(B, 2000n * E18)).wait()
  await (await feeDist.setDeveloperAddress(DEV_ADDR)).wait()

  // ---- 资金与 Vault 存款 ----
  await (await tokenA.transfer(makerAddr, 1000n * E18)).wait()
  await (await tokenB.transfer(takerAddr, 1000n * E18)).wait()
  const vaultW = (w: ethers.Signer) => new ethers.Contract(V, artifact('Vault').abi, w)
  await (await tokenA.connect(maker).approve(V, ethers.MaxUint256)).wait()
  await (await vaultW(maker).deposit(A, 400n * E18)).wait()
  await (await tokenB.connect(taker).approve(V, ethers.MaxUint256)).wait()
  await (await vaultW(taker).deposit(B, 1000n * E18)).wait()
  await (await tokenB.connect(owner).approve(V, ethers.MaxUint256)).wait()
  await (await vaultW(owner).deposit(B, 100n * E18)).wait()

  // ---- 订单（固定字段，两路径逐字一致） ----
  const network = await provider.getNetwork()
  const domain = { name: '比特100', version: '1', chainId: Number(network.chainId), verifyingContract: S }
  const types = ORDER_TYPES as unknown as Record<string, ethers.TypedDataField[]>
  interface Signed {
    data: OrderData
    sig: string
    digest: string
  }
  const signed = new Map<string, Signed>()
  async function signOrder(
    id: string,
    signer: ethers.Wallet | ethers.NonceManager,
    userAddress: string,
    side: 0 | 1,
    priceWei: bigint,
    amountToken0: bigint,
    nonce: number,
    ts: number,
    expiresAt = EXP,
  ): Promise<Signed> {
    const data: OrderData = {
      orderId: id,
      userAddress,
      tokenIn: A,
      tokenOut: B,
      amountIn: amountToken0.toString(),
      amountOut: ((amountToken0 * priceWei) / E18).toString(),
      price: priceWei.toString(),
      timestamp: ts,
      expiresAt,
      nonce,
      side,
    }
    const msg = {
      orderId: data.orderId, userAddress: data.userAddress, tokenIn: data.tokenIn, tokenOut: data.tokenOut,
      amountIn: data.amountIn, amountOut: data.amountOut, price: data.price, timestamp: data.timestamp,
      expiresAt: data.expiresAt, nonce: data.nonce, side: data.side,
    }
    const w = signer instanceof ethers.NonceManager ? (signer as unknown as { signer: ethers.Wallet }).signer ?? signer : signer
    const sig = await (w as ethers.Wallet).signTypedData(domain, types, msg)
    const entry = { data, sig, digest: hashOrderWithDomain(domain, data) }
    signed.set(id, entry)
    return entry
  }
  const P20 = 2n * E18
  const P21 = 21n * (E18 / 10n)
  const P22 = 22n * (E18 / 10n)
  const P25 = 25n * (E18 / 10n)
  const makerW = new ethers.Wallet(MAKER_KEY, provider)
  const takerW = new ethers.Wallet(TAKER_KEY, provider)
  const ownerW = new ethers.Wallet(OWNER_KEY, provider)
  // S1
  await signOrder('ml-m1', makerW, makerAddr, 1, P20, tok(40n), 0, BASE)
  await signOrder('ml-m2', makerW, makerAddr, 1, P21, tok(50n), 1, BASE + 1)
  await signOrder('ml-m3', makerW, makerAddr, 1, P22, tok(60n), 2, BASE + 2)
  await signOrder('ml-t1', takerW, takerAddr, 0, P25, tok(120n), 0, BASE + 3)
  // S2
  await signOrder('ml-t2', takerW, takerAddr, 0, P25, tok(100n), 1, BASE + 4)
  // S3（m5 nonce 3 先行成交，m4 nonce 4）
  await signOrder('ml-m4', makerW, makerAddr, 1, P20, tok(10n), 4, BASE + 5)
  await signOrder('ml-m5', makerW, makerAddr, 1, P21, tok(10n), 3, BASE + 6)
  await signOrder('ml-oc', ownerW, ownerAddr, 0, P21, tok(10n), 0, BASE + 8)
  await signOrder('ml-t3', takerW, takerAddr, 0, P25, tok(20n), 2, BASE + 7)
  // S5
  for (let i = 0; i < 55; i++) {
    await signOrder(`ml-c${String(i).padStart(2, '0')}`, makerW, makerAddr, 1, P20, tok(1n), 5 + i, BASE + 100 + i)
  }
  await signOrder('ml-t4', takerW, takerAddr, 0, P25, tok(60n), 3, BASE + 200)

  // ---- 结算脚手架（生产 ABI / prune；Fill 组装同 driver.ts 内联口径） ----
  const settleT = new ethers.Contract(S, SETTLEMENT_ABI, taker)
  const settleO = new ethers.Contract(S, SETTLEMENT_ABI, owner)
  const settleR = new ethers.Contract(S, artifact('Settlement').abi, provider)
  const vaultT = new ethers.Contract(V, VAULT_LOCK_ABI, taker)
  const vaultO = new ethers.Contract(V, VAULT_LOCK_ABI, owner)
  const fillOf = (makerId: string, takerId: string, qty: bigint, quote: bigint): ContractFill => {
    const m = signed.get(makerId)!
    const t = signed.get(takerId)!
    return {
      makerOrder: { order: orderDataToContractOrder(m.data), signature: m.sig },
      takerOrder: { order: orderDataToContractOrder(t.data), signature: t.sig },
      tokenIn: A,
      tokenOut: B,
      amountIn: qty,
      amountOut: quote,
      gasReimburseIn: 0n,
      gasReimburseOut: 0n,
    }
  }
  async function ensureLock(id: string, vaultC: ethers.Contract) {
    const s = signed.get(id)!
    const lock = await vaultC.orderLocks(s.digest)
    const remaining = BigInt(lock.remaining ?? lock[2] ?? 0n)
    if (remaining > 0n) return
    await (await vaultC.lockForOrder(orderDataToContractOrder(s.data), s.sig)).wait()
  }
  function collectEvents(sc: Scenario, receipt: ethers.TransactionReceipt) {
    sc.settleGasUsedTotal = (BigInt(sc.settleGasUsedTotal) + receipt.gasUsed).toString()
    for (const log of receipt.logs) {
      try {
        const parsed = settleR.interface.parseLog(log)
        if (parsed?.name === 'GasCostShared') {
          sc.gasEvents.push({
            gasUsed: parsed.args.gasUsed.toString(),
            reason: parsed.args.reason.toString(),
            makerDeduct: parsed.args.makerDeduct.toString(),
            makerShortfall: parsed.args.makerShortfall.toString(),
            takerDeduct: parsed.args.takerDeduct.toString(),
            takerShortfall: parsed.args.takerShortfall.toString(),
          })
        }
      } catch { /* not ours */ }
    }
  }
  const legOf = (makerId: string, takerId: string, qty: bigint, price: bigint, quote: bigint): Leg => ({
    makerOrderId: makerId, takerOrderId: takerId,
    qtyToken0: qty.toString(), priceWei: price.toString(), quoteAmount: quote.toString(),
  })
  /** 撮合 → 组装 → 落锁 → 预检剔腿 → 批结算；返回场景记录 */
  async function runFrontendMatch(
    name: string,
    takerId: string,
    book: MatcherOrder[],
  ): Promise<{ sc: Scenario; keptFills: ContractFill[] }> {
    const sc: Scenario = { name, legs: [], settledLegs: [], staleLegs: [], remainderToken0: '0', gasEvents: [], settleGasUsedTotal: '0' }
    const t = signed.get(takerId)!
    const matched = matchTaker(
      { trader: t.data.userAddress, side: 'buy', priceWei: BigInt(t.data.price), amountToken0: BigInt(t.data.amountIn) },
      book,
    )
    sc.remainderToken0 = matched.remainderToken0.toString()
    const legs: Leg[] = matched.legs.map((l) => legOf(l.makerOrderId, takerId, l.qtyToken0, l.priceWei, l.quoteAmount))
    sc.legs = legs
    const fills = matched.legs.map((l) => fillOf(l.makerOrderId, takerId, l.qtyToken0, l.quoteAmount))
    await ensureLock(takerId, vaultT)
    for (const l of matched.legs) await ensureLock(l.makerOrderId, vaultT)
    const outcome = await simulateAndPrune(
      fills,
      async (batch) => { await settleT.settleTradesBatch.staticCall(batch) },
      async (one) => {
        try { await settleT.settleTrade.staticCall(one); return null } catch (e) { return String(e) }
      },
    )
    for (const p of outcome.pruned) sc.staleLegs.push(legs[p.index])
    if (!outcome.batchSimOk || outcome.kept.length === 0) {
      if (fills.length > 0 && outcome.kept.length > 0) throw new Error(`${name}: batch sim failed after prune`)
      return { sc, keptFills: [] }
    }
    const keptIdx = outcome.kept.map((f) => fills.indexOf(f))
    const estimated = await settleT.settleTradesBatch.estimateGas(outcome.kept)
    const gasLimit = (estimated * 125n) / 100n > 1000000n ? (estimated * 125n) / 100n : 1000000n
    const tx = await settleT.settleTradesBatch(outcome.kept, { gasLimit })
    const receipt = await tx.wait()
    collectEvents(sc, receipt!)
    sc.settledLegs = keptIdx.map((i) => legs[i])
    return { sc, keptFills: outcome.kept }
  }
  const bookEntry = (id: string, remaining: bigint): MatcherOrder => {
    const s = signed.get(id)!
    return {
      orderId: id, trader: s.data.userAddress, side: 'sell',
      priceWei: BigInt(s.data.price), remainingToken0: remaining, timestamp: s.data.timestamp,
    }
  }

  const scenarios: Scenario[] = []

  // ---- S1 多档市价买 ----
  const s1 = await runFrontendMatch('S1-multilevel', 'ml-t1', [
    bookEntry('ml-m1', tok(40n)), bookEntry('ml-m2', tok(50n)), bookEntry('ml-m3', tok(60n)),
  ])
  if (s1.sc.settledLegs.length !== 3) throw new Error(`S1: expected 3 settled legs, got ${s1.sc.settledLegs.length}`)
  scenarios.push(s1.sc)
  console.log('S1 done: legs', s1.sc.legs.length)

  // ---- S2 部分成交 + 余量取消（簿上只剩 m3 的 30） ----
  const s2 = await runFrontendMatch('S2-partial-remainder', 'ml-t2', [bookEntry('ml-m3', tok(30n))])
  if (s2.sc.settledLegs.length !== 1 || s2.sc.remainderToken0 !== tok(70n).toString()) {
    throw new Error(`S2: expected 1 leg + remainder 70, got ${s2.sc.settledLegs.length} / ${s2.sc.remainderToken0}`)
  }
  scenarios.push(s2.sc)
  console.log('S2 done: remainder', s2.sc.remainderToken0)

  // ---- S3 陈旧腿：oc 通道先全量成交 m5，再按旧快照撮合 ----
  const s3: Scenario = { name: 'S3-stale-leg', legs: [], settledLegs: [], staleLegs: [], remainderToken0: '0', gasEvents: [], settleGasUsedTotal: '0' }
  await ensureLock('ml-m5', vaultO)
  await ensureLock('ml-oc', vaultO)
  const ocFill = fillOf('ml-m5', 'ml-oc', tok(10n), tok(21n))
  const ocTx = await settleO.settleTrade(ocFill, { gasLimit: 3000000n })
  const ocReceipt = await ocTx.wait()
  collectEvents(s3, ocReceipt!)
  s3.settledLegs.push(legOf('ml-m5', 'ml-oc', tok(10n), P21, tok(21n)))
  const s3main = await runFrontendMatch('S3-stale-leg', 'ml-t3', [
    bookEntry('ml-m4', tok(10n)), bookEntry('ml-m5', tok(10n)),
  ])
  s3.legs = s3main.sc.legs
  s3.remainderToken0 = s3main.sc.remainderToken0
  s3.staleLegs = s3main.sc.staleLegs
  s3.settledLegs.push(...s3main.sc.settledLegs)
  s3.gasEvents.push(...s3main.sc.gasEvents)
  s3.settleGasUsedTotal = (BigInt(s3.settleGasUsedTotal) + BigInt(s3main.sc.settleGasUsedTotal)).toString()
  if (s3.staleLegs.length !== 1 || s3.staleLegs[0].makerOrderId !== 'ml-m5') {
    throw new Error(`S3: expected ml-m5 pruned, got ${JSON.stringify(s3.staleLegs)}`)
  }
  scenarios.push(s3)
  console.log('S3 done: pruned', s3.staleLegs.map((l) => l.makerOrderId).join(','))

  // ---- S5 腿数触顶 ----
  const s5book: MatcherOrder[] = []
  for (let i = 0; i < 55; i++) s5book.push(bookEntry(`ml-c${String(i).padStart(2, '0')}`, tok(1n)))
  const t4 = signed.get('ml-t4')!
  const matched5 = matchTaker(
    { trader: t4.data.userAddress, side: 'buy', priceWei: BigInt(t4.data.price), amountToken0: BigInt(t4.data.amountIn) },
    s5book,
  )
  if (matched5.legs.length !== 55) throw new Error(`S5: expected 55 legs, got ${matched5.legs.length}`)
  const { capped, overflow } = capLegs(matched5.legs)
  if (capped.length !== 50 || overflow !== 5) throw new Error(`S5: capLegs expected 50/5, got ${capped.length}/${overflow}`)
  // 合约硬顶断言：51 腿整批 staticCall 必须 revert
  const fills51 = matched5.legs.slice(0, 51).map((l) => fillOf(l.makerOrderId, 'ml-t4', l.qtyToken0, l.quoteAmount))
  let capRevert = ''
  try {
    await settleT.settleTradesBatch.staticCall(fills51)
  } catch (e) {
    capRevert = String(e).slice(0, 200)
  }
  if (!capRevert) throw new Error('S5: settleTradesBatch with 51 fills must revert (MAX_BATCH_SIZE)')
  const s5: Scenario = { name: 'S5-leg-cap', legs: [], settledLegs: [], staleLegs: [], remainderToken0: matched5.remainderToken0.toString(), gasEvents: [], settleGasUsedTotal: '0' }
  s5.legs = matched5.legs.map((l) => legOf(l.makerOrderId, 'ml-t4', l.qtyToken0, l.priceWei, l.quoteAmount))
  const fills50 = capped.map((l) => fillOf(l.makerOrderId, 'ml-t4', l.qtyToken0, l.quoteAmount))
  await ensureLock('ml-t4', vaultT)
  for (const l of capped) await ensureLock(l.makerOrderId, vaultT)
  const out5 = await simulateAndPrune(
    fills50,
    async (batch) => { await settleT.settleTradesBatch.staticCall(batch) },
    async (one) => {
      try { await settleT.settleTrade.staticCall(one); return null } catch (e) { return String(e) }
    },
  )
  if (!out5.batchSimOk || out5.kept.length !== 50) throw new Error(`S5: batch of 50 must pass preflight (kept ${out5.kept.length})`)
  const est5 = await settleT.settleTradesBatch.estimateGas(out5.kept)
  const tx5 = await settleT.settleTradesBatch(out5.kept, { gasLimit: (est5 * 125n) / 100n })
  const rc5 = await tx5.wait()
  collectEvents(s5, rc5!)
  s5.settledLegs = out5.kept.map((f) => s5.legs[fills50.indexOf(f)])
  scenarios.push(s5)
  console.log('S5 done: settled', s5.settledLegs.length, 'capRevert:', capRevert.slice(0, 80))

  // ---- S4（前端单方）过期腿剔除 ----
  const latest = await provider.getBlock('latest')
  const chainNow = latest!.timestamp
  await signOrder('ml-x1', makerW, makerAddr, 1, P20, tok(10n), 60, chainNow)
  await signOrder('ml-x2', makerW, makerAddr, 1, P21, tok(10n), 61, chainNow, chainNow + 30)
  await signOrder('ml-t5', takerW, takerAddr, 0, P25, tok(20n), 4, chainNow)
  await ensureLock('ml-x1', vaultT)
  await ensureLock('ml-x2', vaultT)
  const s4run = await (async () => {
    const t5 = signed.get('ml-t5')!
    const matched = matchTaker(
      { trader: t5.data.userAddress, side: 'buy', priceWei: BigInt(t5.data.price), amountToken0: BigInt(t5.data.amountIn) },
      [bookEntry('ml-x1', tok(10n)), bookEntry('ml-x2', tok(10n))],
    )
    if (matched.legs.length !== 2) throw new Error(`S4: expected 2 legs pre-expiry, got ${matched.legs.length}`)
    const fills = matched.legs.map((l) => fillOf(l.makerOrderId, 'ml-t5', l.qtyToken0, l.quoteAmount))
    await ensureLock('ml-t5', vaultT)
    // 时间推进：x2 在结算前过期（落锁时仍有效——生产中的真实竞态）
    await provider.send('evm_increaseTime', [60])
    await provider.send('evm_mine', [])
    const outcome = await simulateAndPrune(
      fills,
      async (batch) => { await settleT.settleTradesBatch.staticCall(batch) },
      async (one) => {
        try { await settleT.settleTrade.staticCall(one); return null } catch (e) { return String(e) }
      },
    )
    if (!outcome.batchSimOk || outcome.kept.length !== 1 || outcome.pruned.length !== 1) {
      throw new Error(`S4: expected 1 kept / 1 pruned, got ${outcome.kept.length}/${outcome.pruned.length} simOk=${outcome.batchSimOk}`)
    }
    const prunedLeg = matched.legs[outcome.pruned[0].index]
    if (prunedLeg.makerOrderId !== 'ml-x2') throw new Error(`S4: pruned leg must be ml-x2, got ${prunedLeg.makerOrderId}`)
    const est = await settleT.settleTradesBatch.estimateGas(outcome.kept)
    const tx = await settleT.settleTradesBatch(outcome.kept, { gasLimit: (est * 125n) / 100n })
    const receipt4 = await tx.wait()
    if (!receipt4 || receipt4.status !== 1) throw new Error('S4: settle batch failed')
    const tmpSc: Scenario = { name: 'S4', legs: [], settledLegs: [], staleLegs: [], remainderToken0: '0', gasEvents: [], settleGasUsedTotal: '0' }
    collectEvents(tmpSc, receipt4)
    if (tmpSc.gasEvents.length !== 1) throw new Error(`S4: expected 1 gas event, got ${tmpSc.gasEvents.length}`)
    return {
      keptMakerOrderId: matched.legs[0].makerOrderId,
      prunedMakerOrderId: prunedLeg.makerOrderId,
      prunedReason: outcome.pruned[0].reason.slice(0, 160),
      selfCheck: 'passed',
      gasEvent: tmpSc.gasEvents[0],
    }
  })()
  console.log('S4 done:', JSON.stringify(s4run))

  // ---- 结果采集 ----
  const vaultR = new ethers.Contract(V, artifact('Vault').abi, provider)
  const bal = async (t: string, u: string) => (await vaultR.balanceOf(t, u)).toString()
  const erc = async (c: ethers.Contract, u: string) => (await c.balanceOf(u)).toString()
  const orders: Record<string, string> = {}
  const filled: Record<string, { in: string; out: string }> = {}
  for (const [id, s] of signed) {
    orders[id] = s.digest
    filled[id] = {
      in: (await settleR.orderFilledIn(s.digest)).toString(),
      out: (await settleR.orderFilledOut(s.digest)).toString(),
    }
  }
  const result = {
    path: 'frontend',
    addresses: { tokenA: A, tokenB: B, vault: V, feeDistributor: FD, settlement: S },
    orders,
    scenarios,
    filled,
    // 第 62 轮：getCurrentNonce 已删除；nonces 字段改报 nonceBitmap
    // 的 word 0（已消耗 nonce 集合的位图，compare 按位图口径对账）
    nonces: {
      maker: (await settleR.nonceBitmap(makerAddr, 0)).toString(),
      taker: (await settleR.nonceBitmap(takerAddr, 0)).toString(),
      owner: (await settleR.nonceBitmap(ownerAddr, 0)).toString(),
    },
    vault: {
      makerA: await bal(A, makerAddr), makerB: await bal(B, makerAddr),
      takerA: await bal(A, takerAddr), takerB: await bal(B, takerAddr),
      ownerA: await bal(A, ownerAddr), ownerB: await bal(B, ownerAddr),
    },
    feeDistributor: { a: await erc(tokenA, FD), b: await erc(tokenB, FD) },
    developer: { a: await erc(tokenA, DEV_ADDR), b: await erc(tokenB, DEV_ADDR) },
    deposits: { makerA: tok(400n).toString(), takerB: tok(1000n).toString(), ownerB: tok(100n).toString() },
    s5CapRevert: capRevert,
    s4Expiry: s4run,
  }
  writeFileSync(outPath, JSON.stringify(result, null, 2))
  console.log('frontend multileg done:', outPath)
}

main().catch((e) => { console.error(e); process.exit(1) })
