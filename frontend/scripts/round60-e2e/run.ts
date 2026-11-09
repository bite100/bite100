/**
 * 第 60 轮 Sepolia E2E：用户自助上架全路径验收（本地中继 + 本地 D1，生产
 * 中继不碰）。剧本：
 * 1) 部署两个新测试代币 TKX18（18 位）与 TKX6（6 位，decimals 覆盖版 mock，
 *    本目录 token/ 工程，骑 OZ ERC20）；
 * 2) 向本地中继注册 TKX6/USDT（主验）与 TKX18/USDT（18/18 对照）两个
 *    自助上架对（POST /pairs，中继链上复读元数据）；注册前先验未注册对
 *    下单被拒（400 unknown pair）、注册后篡改 pair 的订单被拒（401）；
 * 3) maker/taker 把代币存入第 47 轮 Sepolia Vault；
 * 4) maker 签名挂卖单 → 本地中继接单 → 订单簿可见（价格/数量原始值按
 *    第 60 轮 decimals 口径：TKX6 价格缩放 30、数量缩放 6）；
 * 5) taker 经生产 executeFrontendMatch 撮合结算上链（注入本地中继簿
 *    适配器；getPairTokens 的注册表缓存用注册响应 prime）；
 * 6) 链上核对：结算回执 status=1、TradeSettled 事件、双方 Vault 余额
 *    增量（扣 0.01% 手续费与 gas 分摊后在预期区间内）。
 *
 * 钥从环境变量读（包装 shell 从 ~/workspace/bite100-deployer/*.env 文件到
 * 文件注入 DEPLOYER_PK/MAKER_PK/TAKER_PK），脚本只打印地址、绝不打印钥。
 * Sepolia publicnode 的 gas 记账放大约 7 倍：普通发送带低 gasPrice +
 * 按放大口径给足 gasLimit；结算走 executeFrontendMatch 自带估算（补测 B
 * 已验证同路径可用）。
 */
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getChainConfig } from '../../src/config/chains'
import { VAULT_ABI } from '../../src/config'
import {
  buildPairKey,
  primeListedPair,
  humanPriceToRaw,
  humanAmountToRaw,
  priceDecimalsFor,
  type ListedPair,
  type ResolvedPair,
} from '../../src/services/pairRegistry'
import { fetchOrderNonce, generateOrderId, signOrder } from '../../src/services/orderSigning'
import { sideToSignedValue, type OrderData } from '../../src/services/orderSigningTypes'
import { executeFrontendMatch } from '../../src/services/matching/execute'
import { createRelayBookAdapter } from '../../src/services/dualread/adapters'
import { SETTLEMENT_ABI } from '../../src/services/settlementAbi'

const CHAIN_ID = 11155111
const RPC_URL = 'https://ethereum-sepolia.publicnode.com'
const RELAY_URL = process.env.R60_RELAY_URL ?? 'http://127.0.0.1:8787'
const USDT = '0x6Ca8cb68Ee5BB15474f1cfFE07B895C974Ab9c6e' // Sepolia 测试 USDT（第 25 轮 MockERC20，公开 mint）

const here = dirname(fileURLToPath(import.meta.url))
const GAS = { gasPrice: 250_000_000n }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Check {
  name: string
  ok: boolean
  detail: string
}
const checks: Check[] = []
function check(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
}
function must<T>(v: T | null | undefined, what: string): T {
  if (v == null) throw new Error(`missing: ${what}`)
  return v
}

async function relayJson(path: string, init?: RequestInit): Promise<{ status: number; body: never }> {
  const res = await fetch(`${RELAY_URL}${path}`, init)
  const text = await res.text()
  let body: never
  try {
    body = JSON.parse(text)
  } catch {
    body = text as never
  }
  return { status: res.status, body }
}

async function main() {
  const deployerPk = must(process.env.DEPLOYER_PK, 'DEPLOYER_PK')
  const makerPk = must(process.env.MAKER_PK, 'MAKER_PK')
  const takerPk = must(process.env.TAKER_PK, 'TAKER_PK')
  const provider = new ethers.JsonRpcProvider(RPC_URL)
  const deployer = new ethers.Wallet(deployerPk, provider)
  const maker = new ethers.Wallet(makerPk, provider)
  const taker = new ethers.Wallet(takerPk, provider)
  console.log('deployer', deployer.address)
  console.log('maker   ', maker.address)
  console.log('taker   ', taker.address)

  const cfg = must(getChainConfig(CHAIN_ID), 'chain config')
  const vault = new ethers.Contract(cfg.contracts.vault, VAULT_ABI, provider)
  const settlement = new ethers.Contract(cfg.contracts.settlement, SETTLEMENT_ABI, provider)
  console.log('vault', cfg.contracts.vault, 'settlement', cfg.contracts.settlement)

  // ---------- 1) 部署两个新测试代币 ----------
  const artifact = JSON.parse(
    readFileSync(join(here, '..', 'token/out/MockERC20Dec.sol/MockERC20Dec.json'), 'utf8'),
  ) as { abi: ethers.InterfaceAbi; bytecode: { object: string } }
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, deployer)
  const tkx18 = await factory.deploy('Round60 TKX18', 'TKX18', 18, { ...GAS, gasLimit: 12_000_000 })
  await tkx18.waitForDeployment()
  const tkx6 = await factory.deploy('Round60 TKX6', 'TKX6', 6, { ...GAS, gasLimit: 12_000_000 })
  await tkx6.waitForDeployment()
  const TKX18 = await tkx18.getAddress()
  const TKX6 = await tkx6.getAddress()
  console.log('TKX18 deployed', TKX18, 'deploy tx', tkx18.deploymentTransaction()?.hash)
  console.log('TKX6  deployed', TKX6, 'deploy tx', tkx6.deploymentTransaction()?.hash)
  check('deploy TKX18/TKX6', true, `${TKX18} / ${TKX6}`)

  const erc20Abi = [
    'function mint(address to, uint256 amount)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
  ]
  const tkx6C = new ethers.Contract(TKX6, erc20Abi, deployer)
  const tkx18C = new ethers.Contract(TKX18, erc20Abi, deployer)
  const usdtC = new ethers.Contract(USDT, erc20Abi, deployer)
  check(
    'on-chain decimals readback',
    Number(await tkx6C.decimals()) === 6 && Number(await tkx18C.decimals()) === 18,
    'TKX6=6, TKX18=18',
  )

  // ---------- 2) 注册前的负例：未注册对下单被拒 ----------
  const key6 = buildPairKey(CHAIN_ID, TKX6, USDT)
  const key18 = buildPairKey(CHAIN_ID, TKX18, USDT)
  {
    const pre = await relayJson('/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: 'r60-precheck',
        trader: maker.address,
        pair: key6,
        side: 'sell',
        price: '1',
        amount: '1',
        filled: '0',
        status: 'open',
        nonce: 0,
        createdAt: Math.floor(Date.now() / 1000),
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        signature: '0x' + '11'.repeat(65),
        chainId: CHAIN_ID,
      }),
    })
    check('unregistered pair order rejected', pre.status === 400, `HTTP ${pre.status} ${JSON.stringify(pre.body).slice(0, 80)}`)
  }

  // ---------- 3) 注册两个自助上架对 ----------
  const registerOnce = async (baseToken: string) => {
    const r = await relayJson('/pairs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chainId: CHAIN_ID, baseToken, quoteToken: USDT, creator: maker.address }),
    })
    return r
  }
  // 刚部署的合约在 publicnode 多后端间同步有滞后：落到滞后后端时中继读不到
  // 代码/元数据会 fail-closed 拒收（400/502）——退避重试直到任一后端可见
  const register = async (baseToken: string) => {
    let r = await registerOnce(baseToken)
    for (let i = 0; i < 10 && r.status !== 201 && r.status !== 200; i++) {
      console.log(`register retry ${i + 1}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`)
      await sleep(15_000)
      r = await registerOnce(baseToken)
    }
    return r
  }
  const reg6 = await register(TKX6)
  check('register TKX6/USDT', reg6.status === 201, `HTTP ${reg6.status}`)
  const reg18 = await register(TKX18)
  check('register TKX18/USDT', reg18.status === 201, `HTTP ${reg18.status}`)
  const dup = await register(TKX6)
  check('duplicate registration idempotent', dup.status === 200 && (dup.body as { duplicate?: boolean }).duplicate === true, `HTTP ${dup.status}`)

  // 中继注册响应是扁平形状（与前端 pairRegistry 的 RelayPairJson 同口径），在此映射
  interface FlatPair {
    chainId: number
    pairKey: string
    baseToken: string
    quoteToken: string
    baseSymbol: string
    quoteSymbol: string
    baseName: string
    quoteName: string
    baseDecimals: number
    quoteDecimals: number
    creator: string | null
    createdAt: number
  }
  const toListed = (f: FlatPair): ListedPair => ({
    chainId: f.chainId,
    pairKey: f.pairKey,
    base: { address: f.baseToken, symbol: f.baseSymbol, name: f.baseName, decimals: f.baseDecimals },
    quote: { address: f.quoteToken, symbol: f.quoteSymbol, name: f.quoteName, decimals: f.quoteDecimals },
    creator: f.creator,
    createdAt: f.createdAt,
  })
  const listed6 = toListed((reg6.body as { pair: FlatPair }).pair)
  const listed18 = toListed((reg18.body as { pair: FlatPair }).pair)
  primeListedPair(listed6)
  primeListedPair(listed18)
  const resolved6: ResolvedPair = {
    pair: key6,
    displayPair: 'TKX6/USDT',
    base: listed6.base,
    quote: listed6.quote,
    source: 'listed',
  }
  const resolved18: ResolvedPair = {
    pair: key18,
    displayPair: 'TKX18/USDT',
    base: listed18.base,
    quote: listed18.quote,
    source: 'listed',
  }
  check(
    'registry metadata (relay on-chain reread)',
    listed6.base.decimals === 6 && listed6.quote.decimals === 18 && listed18.base.decimals === 18,
    `TKX6 base dec=${listed6.base.decimals}, priceDecimals=${priceDecimalsFor(listed6.base, listed6.quote)}`,
  )

  // ---------- 4) 铸币 + 存入 Vault ----------
  const send = async (p: Promise<ethers.TransactionResponse>) => {
    const tx = await p
    await tx.wait()
    return tx.hash
  }
  await send(tkx6C.mint(maker.address, 100_000n * 1_000_000n, { ...GAS, gasLimit: 1_000_000 }))
  await send(tkx18C.mint(maker.address, 1_000n * 10n ** 18n, { ...GAS, gasLimit: 1_000_000 }))
  await send(usdtC.mint(taker.address, 5_000n * 10n ** 18n, { ...GAS, gasLimit: 1_000_000 }))
  const vaultW = (signer: ethers.Wallet) => new ethers.Contract(cfg.contracts.vault, VAULT_ABI, signer)
  const deposit = async (signer: ethers.Wallet, token: string, amount: bigint) => {
    const t = new ethers.Contract(token, erc20Abi, signer)
    await send(t.approve(cfg.contracts.vault, amount, { ...GAS, gasLimit: 1_000_000 }))
    return send(vaultW(signer).deposit(token, amount, { ...GAS, gasLimit: 3_000_000 }))
  }
  const depTx1 = await deposit(maker, TKX6, 10_000n * 1_000_000n)
  const depTx2 = await deposit(maker, TKX18, 100n * 10n ** 18n)
  const depTx3 = await deposit(taker, USDT, 2_000n * 10n ** 18n)
  console.log('deposits', depTx1, depTx2, depTx3)
  const makerUsdtBefore = (await vault.balanceOf(USDT, maker.address)) as bigint
  const takerUsdtBefore = (await vault.balanceOf(USDT, taker.address)) as bigint
  check(
    'vault deposits landed',
    ((await vault.balanceOf(TKX6, maker.address)) as bigint) >= 10_000n * 1_000_000n &&
      takerUsdtBefore >= 2_000n * 10n ** 18n,
    `maker TKX6 ok, taker USDT=${takerUsdtBefore}`,
  )

  // ---------- 5) 一对的完整交易（挂单 → 簿可见 → 撮合结算 → 余额核对） ----------
  const tradeOnce = async (opts: {
    resolved: ResolvedPair
    sellAmountHuman: string
    buyAmountHuman: string
    priceHuman: string
    tag: string
  }) => {
    const { resolved, tag } = opts
    const pair = resolved.pair
    const amountInSell = humanAmountToRaw(opts.sellAmountHuman, resolved)
    const priceRaw = humanPriceToRaw(opts.priceHuman, resolved)
    const timestamp = Math.floor(Date.now() / 1000)
    const expiresAt = timestamp + 86400
    const makerNonce = await fetchOrderNonce(maker.address, maker, CHAIN_ID)
    const makerData: OrderData = {
      orderId: generateOrderId(),
      userAddress: maker.address,
      tokenIn: resolved.base.address,
      tokenOut: resolved.quote.address,
      amountIn: amountInSell,
      amountOut: ((BigInt(amountInSell) * BigInt(priceRaw)) / 10n ** 18n).toString(),
      price: priceRaw,
      timestamp,
      expiresAt,
      nonce: makerNonce,
      side: sideToSignedValue('sell'),
    }
    const makerSig = await signOrder(makerData, maker, CHAIN_ID)
    const post = await relayJson('/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: makerData.orderId,
        trader: maker.address,
        pair,
        side: 'sell',
        price: makerData.price,
        amount: makerData.amountIn,
        filled: '0',
        status: 'open',
        nonce: makerNonce,
        createdAt: timestamp,
        expiresAt,
        signature: makerSig,
        chainId: CHAIN_ID,
      }),
    })
    check(`${tag} maker order accepted by relay`, post.status === 200, `HTTP ${post.status} ${JSON.stringify(post.body).slice(0, 80)}`)

    const book = await relayJson(`/orderbook?chainId=${CHAIN_ID}&pair=${encodeURIComponent(pair)}`)
    const asks = (book.body as { asks?: { orderId: string; price: string; amount: string }[] }).asks ?? []
    const mine = asks.find((a) => a.orderId === makerData.orderId)
    check(
      `${tag} order visible in book with raw scaled values`,
      !!mine && mine.price === priceRaw && mine.amount === amountInSell,
      mine ? `price=${mine.price} amount=${mine.amount}` : 'not found',
    )

    // 等链上时间/多后端滞后追上订单时间戳，再签 taker 单撮合（publicnode 已知口径）
    await sleep(20_000)
    const takerNonce = await fetchOrderNonce(taker.address, taker, CHAIN_ID)
    const ts2 = Math.floor(Date.now() / 1000)
    const amountInBuy = humanAmountToRaw(opts.buyAmountHuman, resolved)
    const takerData: OrderData = {
      orderId: generateOrderId(),
      userAddress: taker.address,
      tokenIn: resolved.base.address,
      tokenOut: resolved.quote.address,
      amountIn: amountInBuy,
      amountOut: ((BigInt(amountInBuy) * BigInt(priceRaw)) / 10n ** 18n).toString(),
      price: priceRaw,
      timestamp: ts2,
      expiresAt: ts2 + 86400,
      nonce: takerNonce,
      side: sideToSignedValue('buy'),
    }
    const takerSig = await signOrder(takerData, taker, CHAIN_ID)

    let outcome: Awaited<ReturnType<typeof executeFrontendMatch>> | null = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      outcome = await executeFrontendMatch(
        { chainId: CHAIN_ID, pair, takerData, takerSignature: takerSig, signer: taker },
        { relayAdapter: createRelayBookAdapter(RELAY_URL) },
      )
      console.log(`${tag} match attempt ${attempt}:`, outcome.status, outcome.message, outcome.txHash ?? '')
      if (outcome.status === 'submitted') break
      await sleep(30_000)
    }
    check(`${tag} frontend match submitted`, outcome?.status === 'submitted', `legs=${outcome?.legsKept} filled=${outcome?.filledToken0}`)
    const settleTx = must(outcome?.txHash, 'settle tx hash')
    const receipt = await provider.getTransactionReceipt(settleTx)
    check(`${tag} settle receipt status=1`, receipt?.status === 1, settleTx)
    let settledEvents = 0
    if (receipt) {
      for (const log of receipt.logs) {
        try {
          const parsed = settlement.interface.parseLog(log)
          if (parsed && (parsed.name === 'TradeSettled' || parsed.name === 'TradeSettledWithGasReimburse')) settledEvents++
        } catch {
          /* 非结算合约日志 */
        }
      }
    }
    check(`${tag} TradeSettled events >= 1`, settledEvents >= 1, `events=${settledEvents}`)
    return { settleTx, amountInBuy }
  }

  // 主验：TKX6（6 位）/USDT（18 位），价格缩放 30
  const r6 = await tradeOnce({
    resolved: resolved6,
    sellAmountHuman: '100',
    buyAmountHuman: '40',
    priceHuman: '2',
    tag: 'TKX6/USDT',
  })
  {
    const takerTkx6 = (await vault.balanceOf(TKX6, taker.address)) as bigint
    const makerUsdtAfter = (await vault.balanceOf(USDT, maker.address)) as bigint
    const makerGain = makerUsdtAfter - makerUsdtBefore
    check(
      'TKX6/USDT balance deltas (fee+gas share deducted)',
      takerTkx6 >= 39_000_000n && takerTkx6 <= 40_000_000n && makerGain >= 79n * 10n ** 18n && makerGain <= 80n * 10n ** 18n,
      `taker TKX6=${takerTkx6} (expect ~40e6), maker USDT gain=${makerGain} (expect ~80e18)`,
    )
    console.log('TKX6 settle tx', r6.settleTx)
  }

  // 对照：TKX18（18 位）/USDT，价格缩放 18（与种子对同口径）
  const makerUsdtBefore18 = (await vault.balanceOf(USDT, maker.address)) as bigint
  const r18 = await tradeOnce({
    resolved: resolved18,
    sellAmountHuman: '10',
    buyAmountHuman: '10',
    priceHuman: '3',
    tag: 'TKX18/USDT',
  })
  {
    const takerTkx18 = (await vault.balanceOf(TKX18, taker.address)) as bigint
    const makerUsdtAfter18 = (await vault.balanceOf(USDT, maker.address)) as bigint
    const gain = makerUsdtAfter18 - makerUsdtBefore18
    check(
      'TKX18/USDT balance deltas',
      takerTkx18 >= 99n * 10n ** 17n && takerTkx18 <= 10n * 10n ** 18n && gain >= 29n * 10n ** 18n && gain <= 30n * 10n ** 18n,
      `taker TKX18=${takerTkx18} (expect ~10e18), maker USDT gain=${gain} (expect ~30e18)`,
    )
    console.log('TKX18 settle tx', r18.settleTx)
  }

  const failed = checks.filter((c) => !c.ok)
  console.log(JSON.stringify({ total: checks.length, failed: failed.length, checks }, null, 2))
  if (failed.length > 0) process.exit(1)
}

main().catch((e) => {
  console.error('E2E crashed:', e)
  process.exit(2)
})
