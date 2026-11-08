/**
 * 阶段 3 块 D1：同单对照 E2E —— 前端路径驱动（本地 anvil，绝不连外网）。
 *
 * 与节点路径驱动（node/internal/settlement/e2e_stage3_dualpath_test.go）
 * 使用完全相同的部署顺序、账户、订单与价格，两条路径的链上结果由
 * compare.mjs 逐项对账（成交量/成交价/gas 对半/FeeDistributor 99/1）。
 *
 * 本驱动尽量骑生产代码：ORDER_TYPES 签名（orderSigningTypes）、摘要
 * （dualread/digest 的 hashOrderWithDomain）、撮合（matching/matcher）、
 * Fill 字段组装（matching/fills 的 orderDataToContractOrder；buildLegFill
 * 依赖应用交易对注册表、无 anvil 链条目，故 Fill 映射在本驱动内按
 * fills.ts 同口径内联，并以 maker 摘要与冻结值断言防漂移）、预检剔腿
 * （matching/prune + SETTLEMENT_ABI staticCall）、落锁（VAULT_LOCK_ABI）、
 * 批结算（SETTLEMENT_ABI settleTradesBatch，用户 taker 钱包自提）。
 *
 * 用法（esbuild 打包后）：node driver.mjs <rpcUrl> <outJson>
 */
import { ethers } from 'ethers'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ORDER_TYPES, type OrderData } from '../../src/services/orderSigningTypes'
import { hashOrderWithDomain } from '../../src/services/dualread/digest'
import { matchTaker } from '../../src/services/matching/matcher'
import { orderDataToContractOrder } from '../../src/services/matching/fills'
import { simulateAndPrune } from '../../src/services/matching/prune'
import { SETTLEMENT_ABI } from '../../src/services/settlementAbi'
import { VAULT_LOCK_ABI } from '../../src/services/vaultAbi'
import type { ContractFill } from '../../src/services/settlementService'

// 工件目录：打包后 import.meta 位置不可靠，显式以环境变量/仓库根解析
const OUT_DIR = process.env.BIT100_CONTRACTS_OUT ?? join(process.cwd(), 'contracts/out')

const OWNER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const MAKER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const TAKER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'
const DEV_ADDR = '0x90F79bf6EB2c4f870365E785982E1f101E93b906'
const E18 = 10n ** 18n
const CREATED = 1700000000
const EXPIRES = 2000000000

function artifact(name: string) {
  const doc = JSON.parse(readFileSync(join(OUT_DIR, `${name}.sol`, `${name}.json`), 'utf8'))
  return { abi: doc.abi, bytecode: doc.bytecode.object as string }
}

async function deploy(signer: ethers.Signer, name: string, args: unknown[] = []) {
  const a = artifact(name)
  const factory = new ethers.ContractFactory(a.abi, a.bytecode, signer)
  // 显式 gasLimit（估算 ×1.5）：部分 anvil 链参数下 ethers 默认估算对部署
  // 低估、真实发送 OOG 回滚（块 D 实测，Sepolia 参数 11155111 复现；
  // 与 execute.ts 批结算的估算缓冲同一课）。
  const deployTx = await factory.getDeployTransaction(...args)
  const from = await signer.getAddress()
  const estimated = await signer.provider!.estimateGas({ ...deployTx, from })
  const c = await factory.deploy(...args, { gasLimit: (estimated * 3n) / 2n })
  await c.waitForDeployment()
  return c
}

async function main() {
  const [rpc, outPath] = process.argv.slice(2)
  if (!rpc || !outPath) throw new Error('usage: driver.mjs <rpc> <outJson>')
  const provider = new ethers.JsonRpcProvider(rpc)
  // NonceManager 包裹：anvil 即时出块下 ethers 普通 Wallet 连发会撞 nonce
  const owner = new ethers.NonceManager(new ethers.Wallet(OWNER_KEY, provider))
  const maker = new ethers.NonceManager(new ethers.Wallet(MAKER_KEY, provider))
  const taker = new ethers.NonceManager(new ethers.Wallet(TAKER_KEY, provider))
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

  console.log('setup: deploys done', { A, B, V, FD, S })
  await (await vault.setSettlement(S)).wait()
  await (await settlement.setChainConfig(await chainConfig.getAddress())).wait()
  await (await chainConfig.setQuotePricing(B, 2000n * E18)).wait() // 1 ETH = 2000 TKB
  await (await feeDist.setDeveloperAddress(DEV_ADDR)).wait()

  // ---- 资金与 Vault 存款 ----
  await (await tokenA.transfer(makerAddr, 1000n * E18)).wait()
  await (await tokenB.transfer(takerAddr, 1000n * E18)).wait()
  const vaultW = (w: ethers.Signer) => new ethers.Contract(V, artifact('Vault').abi, w)
  await (await tokenA.connect(maker).approve(V, ethers.MaxUint256)).wait()
  await (await vaultW(maker).deposit(A, 100n * E18)).wait()
  await (await tokenB.connect(taker).approve(V, ethers.MaxUint256)).wait()
  await (await vaultW(taker).deposit(B, 1000n * E18)).wait()

  // ---- 订单（固定字段，两路径逐字一致） ----
  const network = await provider.getNetwork()
  const domain = { name: '比特100', version: '1', chainId: Number(network.chainId), verifyingContract: S }
  const makerData: OrderData = {
    orderId: 's3-maker-1',
    userAddress: makerAddr,
    tokenIn: A,
    tokenOut: B,
    amountIn: (100n * E18).toString(),
    amountOut: (200n * E18).toString(),
    price: (2n * E18).toString(),
    timestamp: CREATED,
    expiresAt: EXPIRES,
    nonce: 0,
    side: 1,
  }
  const takerData: OrderData = {
    orderId: 's3-taker-1',
    userAddress: takerAddr,
    tokenIn: A,
    tokenOut: B,
    amountIn: (100n * E18).toString(),
    amountOut: (250n * E18).toString(), // 限价 2.5：amountOut=100×2.5
    price: (25n * (E18 / 10n)).toString(),
    timestamp: CREATED,
    expiresAt: EXPIRES,
    nonce: 0,
    side: 0,
  }
  const msg = (d: OrderData) => ({
    orderId: d.orderId, userAddress: d.userAddress, tokenIn: d.tokenIn, tokenOut: d.tokenOut,
    amountIn: d.amountIn, amountOut: d.amountOut, price: d.price, timestamp: d.timestamp,
    expiresAt: d.expiresAt, nonce: d.nonce, side: d.side,
  })
  const types = ORDER_TYPES as unknown as Record<string, ethers.TypedDataField[]>
  const makerSig = await maker.signTypedData(domain, types, msg(makerData))
  const takerSig = await taker.signTypedData(domain, types, msg(takerData))
  const makerDigest = hashOrderWithDomain(domain, makerData)
  const takerDigest = hashOrderWithDomain(domain, takerData)

  console.log('setup: config + deposits done')
  // ---- 前端撮合（生产 matcher） ----
  const matched = matchTaker(
    { trader: takerAddr, side: 'buy', priceWei: BigInt(takerData.price), amountToken0: BigInt(takerData.amountIn) },
    [{ orderId: makerData.orderId, trader: makerAddr, side: 'sell', priceWei: BigInt(makerData.price), remainingToken0: BigInt(makerData.amountIn), timestamp: CREATED }],
  )
  if (matched.legs.length !== 1) throw new Error(`expected 1 leg, got ${matched.legs.length}`)
  const leg = matched.legs[0]

  console.log('match: legs', matched.legs.length)
  // ---- Fill 组装（fills.ts 同口径内联，见文件头说明） ----
  const fill: ContractFill = {
    makerOrder: { order: orderDataToContractOrder(makerData), signature: makerSig },
    takerOrder: { order: orderDataToContractOrder(takerData), signature: takerSig },
    tokenIn: A,
    tokenOut: B,
    amountIn: leg.qtyToken0,
    amountOut: leg.quoteAmount,
    gasReimburseIn: 0n,
    gasReimburseOut: 0n,
  }

  // ---- 落锁补齐（生产 VAULT_LOCK_ABI；taker 作为提交者补双边锁） ----
  const vaultT = new ethers.Contract(V, VAULT_LOCK_ABI, taker)
  for (const [data, sig] of [[makerData, makerSig], [takerData, takerSig]] as const) {
    await (await vaultT.lockForOrder(orderDataToContractOrder(data), sig)).wait()
  }

  console.log('locks done')
  // ---- 预检剔腿（生产 prune + staticCall）→ 批结算自提 ----
  const settleT = new ethers.Contract(S, SETTLEMENT_ABI, taker)
  const outcome = await simulateAndPrune(
    [fill],
    async (batch) => { await settleT.settleTradesBatch.staticCall(batch) },
    async (one) => {
      try { await settleT.settleTrade.staticCall(one); return null } catch (e) { return String(e) }
    },
  )
  if (!outcome.batchSimOk || outcome.kept.length !== 1) throw new Error('preflight failed on frontend path')
  console.log('preflight ok, kept', outcome.kept.length, 'pruned', outcome.pruned.length)
  if (process.env.S3_DEBUG === '1') {
    const populated = await settleT.settleTradesBatch.populateTransaction(outcome.kept)
    try {
      const r = await provider.call({ ...populated, from: takerAddr, gasPrice: 1099096876n })
      console.log('debug call ok:', r)
    } catch (e) {
      const err = e as { data?: string; revert?: unknown; message?: string }
      console.log('debug call reverted. data =', err.data, 'revert =', JSON.stringify(err.revert))
      if (err.data && err.data.length >= 10) {
        try {
          const parsedErr = settleR.interface.parseError(err.data)
          console.log('parsed error:', parsedErr?.name, parsedErr?.args)
        } catch { /* ignore */ }
      }
    }
    process.exit(0)
  }
  const tx = await settleT.settleTradesBatch(outcome.kept, { gasLimit: 3000000n })
  const receipt = await tx.wait()

  // ---- 结果采集 ----
  const vaultR = new ethers.Contract(V, artifact('Vault').abi, provider)
  // 结果读取用全量工件 ABI（SETTLEMENT_ABI 产品子集不含 orderFilledIn/Out）
  const settleR = new ethers.Contract(S, artifact('Settlement').abi, provider)
  const bal = async (t: string, u: string) => (await vaultR.balanceOf(t, u)).toString()
  const erc = async (c: ethers.Contract, u: string) => (await c.balanceOf(u)).toString()
  let gasEvent: Record<string, string> | null = null
  for (const log of receipt.logs) {
    try {
      const parsed = settleR.interface.parseLog(log)
      if (parsed?.name === 'GasCostShared') {
        gasEvent = {
          gasUsed: parsed.args.gasUsed.toString(),
          gasCostWei: parsed.args.gasCostWei.toString(),
          reason: parsed.args.reason.toString(),
          makerDeduct: parsed.args.makerDeduct.toString(),
          makerShortfall: parsed.args.makerShortfall.toString(),
          takerDeduct: parsed.args.takerDeduct.toString(),
          takerShortfall: parsed.args.takerShortfall.toString(),
        }
      }
    } catch { /* not ours */ }
  }
  const result = {
    path: 'frontend',
    addresses: { tokenA: A, tokenB: B, vault: V, feeDistributor: FD, settlement: S },
    makerDigest, takerDigest,
    execPrice: leg.priceWei.toString(),
    qtyToken0: leg.qtyToken0.toString(),
    quoteAmount: leg.quoteAmount.toString(),
    settleTx: receipt.hash,
    settleGasUsed: receipt.gasUsed.toString(),
    vault: {
      makerA: await bal(A, makerAddr), makerB: await bal(B, makerAddr),
      takerA: await bal(A, takerAddr), takerB: await bal(B, takerAddr),
    },
    feeDistributor: { a: await erc(tokenA, FD), b: await erc(tokenB, FD) },
    developer: { a: await erc(tokenA, DEV_ADDR), b: await erc(tokenB, DEV_ADDR) },
    filled: {
      makerIn: (await settleR.orderFilledIn(makerDigest)).toString(),
      makerOut: (await settleR.orderFilledOut(makerDigest)).toString(),
      takerIn: (await settleR.orderFilledIn(takerDigest)).toString(),
      takerOut: (await settleR.orderFilledOut(takerDigest)).toString(),
    },
    nonces: {
      maker: (await settleR.getCurrentNonce(makerAddr)).toString(),
      taker: (await settleR.getCurrentNonce(takerAddr)).toString(),
    },
    gasEvent,
  }
  writeFileSync(outPath, JSON.stringify(result, null, 2))
  console.log('frontend path done:', outPath)
}

main().catch((e) => { console.error(e); process.exit(1) })
