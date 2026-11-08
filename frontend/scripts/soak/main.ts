/**
 * 合成压测（第 35 轮 D-10c）— CLI 入口。
 *
 * 用法（先 `node build.mjs` 打包，再以 node 跑 dist/soak.mjs）：
 *   node dist/soak.mjs smoke   一次冒烟：双链各签发一小批 → 双发 →
 *                              等传播 → 每链一轮影子评估 → JSONL 落盘
 *   node dist/soak.mjs run     持续压测：按间隔循环（签发小批 + 评估 +
 *                              落盘），直到被终止（7 天压测由主聊天启动）
 *
 * 配置全走环境变量（见 README）：SOAK_KEYS_DIR / SOAK_RELAY_URL /
 * SOAK_NODE_URL_<chainId> / SOAK_OUT / SOAK_INTERVAL_SEC /
 * SOAK_SUBMIT_GAP_MS。密钥只经 generator 从 SOAK_KEYS_DIR 读取，
 * 本文件不接触密钥材料。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  generateBatch,
  loadWallets,
  submitBatch,
  type OrderSpec,
} from './generator'
import { createSoakRunner, type SoakChainConfig } from './runner'

const KEYS_DIR =
  process.env.SOAK_KEYS_DIR ?? join(homedir(), 'workspace', 'bite100-deployer')
const RELAY_URL = process.env.SOAK_RELAY_URL ?? 'http://127.0.0.1:8787'
const OUT =
  process.env.SOAK_OUT ??
  join(homedir(), 'workspace', 'soak-data', 'soak-metrics.jsonl')
const GAP_MS = Number(process.env.SOAK_SUBMIT_GAP_MS ?? 2000)
const INTERVAL_SEC = Number(process.env.SOAK_INTERVAL_SEC ?? 600)
const PAIR = 'BTC/USDT'
const PRICE = '2000'

function chainCfgs(): SoakChainConfig[] {
  return [
    {
      chainId: 11155111,
      nodeUrl:
        process.env.SOAK_NODE_URL_11155111 ?? 'https://node.aaxx123456.trade',
      relayUrl: RELAY_URL,
      pairs: [PAIR],
    },
    {
      chainId: 84532,
      nodeUrl:
        process.env.SOAK_NODE_URL_84532 ?? 'https://node-base.aaxx123456.trade',
      relayUrl: RELAY_URL,
      pairs: [PAIR],
    },
  ]
}

/** 冒烟批次：双链都覆盖买卖两侧中钱包资金能落锁的方向（见 generator 预检） */
function smokeSpecs(chainId: number): OrderSpec[] {
  if (chainId === 11155111) {
    return [
      { role: 'maker', pair: PAIR, side: 'sell', amount: '0.001', price: PRICE },
      { role: 'maker', pair: PAIR, side: 'buy', amount: '0.001', price: PRICE },
      { role: 'taker', pair: PAIR, side: 'buy', amount: '0.001', price: PRICE },
    ]
  }
  return [
    { role: 'maker', pair: PAIR, side: 'buy', amount: '0.001', price: PRICE },
    { role: 'taker', pair: PAIR, side: 'buy', amount: '0.0005', price: PRICE },
  ]
}

/** 持续压测的轮转批次（含偶发短存活单制造过期场景） */
function cycleSpecs(chainId: number, cycle: number): OrderSpec[] {
  const specs = smokeSpecs(chainId)
  if (cycle % 6 === 5) {
    specs.push({
      role: 'maker',
      pair: PAIR,
      side: 'buy',
      amount: '0.0005',
      price: PRICE,
      ttlSec: 120, // 短存活：两分钟后过期，喂状态机的 EXPIRED 路径
    })
  }
  return specs
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (msg: string) => console.log(`[soak] ${msg}`)

async function generateAndSubmit(
  runner: ReturnType<typeof createSoakRunner>,
  wallets: ReturnType<typeof loadWallets>,
  nonceCursor: Map<string, number>,
  cfg: SoakChainConfig,
  specs: OrderSpec[],
  tamperFirst = false,
): Promise<void> {
  const { generated, skipped } = await generateBatch(
    cfg.chainId,
    wallets,
    specs,
    nonceCursor,
  )
  for (const s of skipped) {
    log(
      `chain ${cfg.chainId} 跳过订单 ${s.spec.role}/${s.spec.side}: ${s.reason}` +
        (s.obligation ? `（义务 ${s.obligation}，可用 ${s.available}）` : ''),
    )
  }
  const tamperDigests = new Set<string>()
  if (tamperFirst && generated.length > 0) {
    tamperDigests.add(generated[0].digest.toLowerCase())
  }
  const results = await submitBatch(
    cfg.nodeUrl,
    cfg.relayUrl,
    generated,
    GAP_MS,
    tamperDigests,
  )
  for (const { gen, outcome } of results) {
    const tampered = tamperDigests.has(gen.digest.toLowerCase())
    runner.ledger.recordSubmitted(gen, outcome, tampered)
    log(
      `chain ${cfg.chainId} 提交 ${gen.role}/${gen.side} digest=${gen.digest.slice(0, 10)}… ` +
        `node=${outcome.node ? 'ok' : `FAIL ${outcome.nodeError}`} ` +
        `relay=${outcome.relay ? 'ok' : `FAIL ${outcome.relayError}`}` +
        (tampered ? '（中继侧 side 已改写注入）' : ''),
    )
  }
}

async function smoke(): Promise<void> {
  const wallets = loadWallets(KEYS_DIR)
  const runner = createSoakRunner(OUT)
  const nonceCursor = new Map<string, number>()
  const cfgs = chainCfgs()
  // Sepolia 批次的第一单走 side 改写注入，验证 D2 在真实链路被抓
  for (const cfg of cfgs) {
    await generateAndSubmit(
      runner,
      wallets,
      nonceCursor,
      cfg,
      smokeSpecs(cfg.chainId),
      cfg.chainId === 11155111,
    )
  }
  // 等传播：轮询影子轮次直到全部自造单被至少一源发现或超时。
  // 判据直接查记账（不走 discovery 的 60s 宽限期口径——那是准入统计
  // 口径，冒烟等传播看的是「已提交且被接单的单是否已被任一源收录」）。
  const pendingCount = (): number => {
    let n = 0
    for (const sub of runner.ledger.submitted.values()) {
      if (!sub.nodeOk && !sub.relayOk) continue
      const seen = runner.ledger.firstSeen.get(sub.digest)
      if (!seen || (seen.node === undefined && seen.relay === undefined)) n += 1
    }
    return n
  }
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline && pendingCount() > 0) {
    await sleep(10_000)
    for (const cfg of cfgs) {
      const probe = await runner.runRound(cfg)
      log(
        `chain ${cfg.chainId} 轮次 ${probe.round}: 待发现 ${pendingCount()}，` +
          `过滤 valid=${probe.filterOutcomes.valid} unknown=${probe.filterOutcomes.unknown} invalid=${probe.filterOutcomes.invalid} tradeable=${probe.filterOutcomes.tradeable}`,
      )
      if (pendingCount() === 0) break
    }
  }
  log(
    pendingCount() === 0
      ? `冒烟完成：全部自造单均被发现，记录已写入 ${OUT}`
      : `冒烟结束（超时）：仍有 ${pendingCount()} 单未被任一源发现，记录已写入 ${OUT}`,
  )
}

async function run(): Promise<void> {
  const wallets = loadWallets(KEYS_DIR)
  const runner = createSoakRunner(OUT)
  const nonceCursor = new Map<string, number>()
  const cfgs = chainCfgs()
  let cycle = 0
  log(`持续压测启动：间隔 ${INTERVAL_SEC}s，记录 ${OUT}`)
  for (;;) {
    cycle += 1
    for (const cfg of cfgs) {
      try {
        await generateAndSubmit(
          runner,
          wallets,
          nonceCursor,
          cfg,
          cycleSpecs(cfg.chainId, cycle),
          cycle % 12 === 11, // 低频 side 改写注入（对抗样本）
        )
        const rec = await runner.runRound(cfg)
        log(
          `cycle ${cycle} chain ${cfg.chainId} 轮次 ${rec.round}: ` +
            `valid=${rec.filterOutcomes.valid} unknown=${rec.filterOutcomes.unknown} ` +
            `invalid=${rec.filterOutcomes.invalid} tradeable=${rec.filterOutcomes.tradeable} ` +
            `发现率=${rec.discovery.successRate ?? '—'}`,
        )
      } catch (e) {
        log(`cycle ${cycle} chain ${cfg.chainId} 异常（继续下一轮）: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    await sleep(INTERVAL_SEC * 1000)
  }
}

const mode = process.argv[2]
if (mode === 'smoke') {
  await smoke()
} else if (mode === 'run') {
  await run()
} else {
  console.error('用法: node dist/soak.mjs <smoke|run>')
  process.exit(2)
}
