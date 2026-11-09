/**
 * 第 49 轮自练 E2E 驱动：用官方 MCP 客户端 SDK 经 stdio 拉起真实
 * MCP server 进程，全程只通过 MCP 工具完成——看簿 → maker 挂单 →
 * taker 吃单撮合结算 → 链上核对（成交量/锁/墓碑/余额方向）→ 部分
 * 成交后 operator 硬撤。Sepolia 与 Base Sepolia 各走一遍全环；
 * 负面用例（主网链/白名单外对/超限/停用 agent/急停）在第一条链
 * 环内一并验。任一断言失败以非零码退出并打印失败项。
 *
 * 定额口径：交易量按双方 Vault 可用余额动态取（共享测试簿上有历史
 * 订单，taker 撮合按价格-时间优先可能先吃掉同价旧单——故第一阶段
 * 循环挂单+撮合，直到链上确认本轮 maker 单成交为止；第二阶段用
 * 独立价格避开同价队列）。断言只认链上读数（成交量按摘要精确比对）。
 *
 * 运行：npm run build && node dist/bit100-mcp-e2e.mjs
 * 环境：BIT100_MCP_E2E_KEYS_DIR（测试钥 env 文件目录，缺省
 * ~/workspace/bite100-deployer）；BIT100_MCP_E2E_CHAINS=11155111,84532
 * 可限定链。agent 注册表与令牌在临时目录随机生成（只存哈希入表、
 * 明文只进子进程环境），审计日志写到 mcp/audit/（gitignored）。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashToken } from './agents'

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = join(here, 'bit100-mcp.mjs')
const mcpRoot = join(here, '..')
const keysDir = process.env.BIT100_MCP_E2E_KEYS_DIR ?? join(homedir(), 'workspace', 'bite100-deployer')
const chains = (process.env.BIT100_MCP_E2E_CHAINS ?? '11155111,84532').split(',').map(Number)

const PAIR = 'TKA/TKB'
const PRICE = '1.5'
const PRICE2 = '1.49'

interface AgentFixture {
  id: string
  role: string
  token: string
  perOrderMaxQuote: string
  enabled: boolean
}

const fixtures: AgentFixture[] = [
  { id: 'maker-e2e', role: 'maker', token: '', perOrderMaxQuote: '100', enabled: true },
  { id: 'taker-e2e', role: 'taker', token: '', perOrderMaxQuote: '100', enabled: true },
  { id: 'operator-e2e', role: 'operator', token: '', perOrderMaxQuote: '100', enabled: true },
  { id: 'capped-e2e', role: 'maker', token: '', perOrderMaxQuote: '0.1', enabled: true },
  { id: 'disabled-e2e', role: 'taker', token: '', perOrderMaxQuote: '100', enabled: false },
]
for (const f of fixtures) f.token = randomBytes(24).toString('hex')

const tmp = mkdtempSync(join(tmpdir(), 'bit100-mcp-e2e-'))
const registryPath = join(tmp, 'agents.json')
writeFileSync(
  registryPath,
  JSON.stringify({
    agents: fixtures.map((f) => ({
      id: f.id,
      tokenHash: hashToken(f.token),
      role: f.role,
      perOrderMaxQuote: f.perOrderMaxQuote,
      dailyMaxQuote: '1000',
      writeRatePerMinute: 60,
      enabled: f.enabled,
    })),
  }),
)

interface ToolOut {
  ok: boolean
  data?: Record<string, unknown>
  error?: { code: string; message: string }
}

const failures: string[] = []
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures.push(`${name} ${detail}`)
}

async function startAgent(f: AgentFixture, extraEnv: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: mcpRoot,
    env: {
      ...(process.env as Record<string, string>),
      BIT100_MCP_AGENTS_CONFIG: registryPath,
      BIT100_MCP_AGENT_TOKEN: f.token,
      BIT100_MCP_KEYFILE_MAKER: join(keysDir, 'maker.env'),
      BIT100_MCP_KEYFILE_TAKER: join(keysDir, 'taker.env'),
      BIT100_MCP_KEYFILE_OPERATOR: join(keysDir, 'wallet.env'),
      BIT100_MCP_AUDIT_DIR: join(mcpRoot, 'audit'),
      ...extraEnv,
    },
    stderr: 'inherit',
  })
  const client = new Client({ name: `e2e-${f.id}`, version: '0.49.0' })
  await client.connect(transport)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolOut> {
  const res = (await client.callTool({ name, arguments: args }, undefined, {
    timeout: 600_000,
  })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean }
  const text = res.content?.find((c) => c.type === 'text')?.text ?? '{}'
  return JSON.parse(text) as ToolOut
}

type Balances = Record<string, unknown>
function humanTotal(balances: Balances, symbol: string): number {
  const tokens = (balances?.tokens ?? {}) as Record<
    string,
    { wallet: { human: string }; vault: { human: string } }
  >
  const t = tokens[symbol]
  if (!t) return Number.NaN
  return Number(t.wallet.human) + Number(t.vault.human)
}
function vaultAvail(balances: Balances, symbol: string): number {
  const tokens = (balances?.tokens ?? {}) as Record<string, { vaultAvailable: { human: string } }>
  const t = tokens[symbol]
  if (!t) return Number.NaN
  return Number(t.vaultAvailable.human)
}

/** 只读调用重试（测试网公共 RPC 有限流、偶发抖动时不让驱动误崩；写调用不重试） */
async function callRead(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  tries = 5,
): Promise<ToolOut> {
  let last: ToolOut = { ok: false, error: { code: 'no_attempt', message: '' } }
  for (let i = 0; i < tries; i++) {
    last = await call(client, name, args)
    if (last.ok) return last
    console.log(`read ${name} attempt ${i + 1} failed: ${last.error?.code} ${last.error?.message ?? ''}`)
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 8_000))
  }
  return last
}
function weiOf(human: string): string {
  const [i, f = ''] = human.split('.')
  return (BigInt(i) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18))).toString()
}
function trimNum(n: number): string {
  return String(Math.floor(n * 1000) / 1000)
}

/** 开跑前清扫：硬撤本方测试钱包名下未过期且仍锁定的旧单（前几轮
 * 自练/验收留下的悬挂锁会占用 Vault 可用量；operator 硬撤是产品
 * 既定的运营手段，这里也顺带多验一次硬撤面）。 */
async function sweepStaleLocks(
  chainId: number,
  operator: Client,
  parties: Array<{ client: Client; label: string }>,
): Promise<void> {
  for (const { client, label } of parties) {
    const bal = await callRead(client, 'get_balances', { chainId })
    const addr = String(bal.data?.address ?? '')
    if (!addr) continue
    const listed = await callRead(client, 'list_orders', { chainId, userAddress: addr, limit: 200 })
    const orders = (listed.data?.orders as Array<{ orderId: string; digest: string }>) ?? []
    for (const o of orders) {
      const st = await callRead(client, 'get_order_status', { chainId, digest: o.digest })
      if (st.ok && st.data?.locked === true && st.data?.cancelled !== true) {
        const c = await call(operator, 'hard_cancel_order', { chainId, digest: o.digest })
        console.log(
          `sweep[${label}]: hard-cancel stale locked order ${o.orderId} → cancelled=${c.data?.cancelled} tx=${c.data?.txHash ?? ''} ${c.error ? `code=${c.error.code}` : ''}`,
        )
      }
    }
  }
}

async function runChain(
  chainId: number,
  maker: Client,
  taker: Client,
  operator: Client,
): Promise<void> {
  console.log(`\n===== chain ${chainId} =====`)
  await sweepStaleLocks(chainId, operator, [
    { client: maker, label: 'maker' },
    { client: taker, label: 'taker' },
  ])
  const makerBal0 = (await callRead(maker, 'get_balances', { chainId })).data!
  const takerBal0 = (await callRead(taker, 'get_balances', { chainId })).data!
  const makerAvail = vaultAvail(makerBal0, 'TKA')
  const takerAvail = vaultAvail(takerBal0, 'TKB')
  // 定额：双方可用量的 40% 以内，且 ≤0.5；给第二阶段留余量
  const size = Math.min(0.5, makerAvail * 0.25, (takerAvail / Number(PRICE)) * 0.25)
  const sizeStr = trimNum(size)
  console.log(
    `avail: maker TKA=${makerAvail} taker TKB=${takerAvail} → size=${sizeStr} (maker TKA total=${humanTotal(makerBal0, 'TKA')}, taker TKB total=${humanTotal(takerBal0, 'TKB')})`,
  )
  check(`[${chainId}] preflight size >= 0.05`, Number(sizeStr) >= 0.05, `size=${sizeStr}`)
  if (Number(sizeStr) < 0.05) return

  // —— 第一阶段：全量成交（同价旧单可能先被吃，循环直到本轮单成交）——
  let filledOk = false
  let lastTx = ''
  for (let attempt = 1; attempt <= 4 && !filledOk; attempt++) {
    const mBefore = (await callRead(maker, 'get_balances', { chainId })).data!
    const tBefore = (await callRead(taker, 'get_balances', { chainId })).data!
    const placed = await call(maker, 'place_order', {
      chainId,
      pair: PAIR,
      side: 'sell',
      price: PRICE,
      amount: sizeStr,
    })
    check(`[${chainId}] maker place_order (attempt ${attempt})`, placed.ok, placed.error?.message ?? '')
    const digest = String(placed.data?.digest ?? '')
    const matched = await call(taker, 'match_order', {
      chainId,
      pair: PAIR,
      side: 'buy',
      price: PRICE,
      amount: sizeStr,
    })
    lastTx = String(matched.data?.txHash ?? '')
    check(
      `[${chainId}] taker match_order submitted (attempt ${attempt})`,
      matched.ok && matched.data?.status === 'submitted',
      `status=${matched.data?.status} tx=${lastTx} msg=${matched.data?.message ?? matched.error?.message ?? ''}`,
    )
    const st = await callRead(maker, 'get_order_status', { chainId, digest })
    const filledWei = (st.data?.filledIn as { wei: string } | undefined)?.wei
    if (st.ok && filledWei === weiOf(sizeStr)) {
      filledOk = true
      const mAfter = (await callRead(maker, 'get_balances', { chainId })).data!
      const tAfter = (await callRead(taker, 'get_balances', { chainId })).data!
      const makerTkbDelta = humanTotal(mAfter, 'TKB') - humanTotal(mBefore, 'TKB')
      const takerTkaDelta = humanTotal(tAfter, 'TKA') - humanTotal(tBefore, 'TKA')
      const expectQuote = Number(sizeStr) * Number(PRICE)
      console.log(
        `filled on attempt ${attempt}: maker TKB delta=${makerTkbDelta} (expect ≈${expectQuote}, ≥${expectQuote * 0.8}) | taker TKA delta=${takerTkaDelta} (expect ≈${sizeStr}, ≥${Number(sizeStr) * 0.8}) settleTx=${lastTx}`,
      )
      check(`[${chainId}] maker TKB increased`, makerTkbDelta >= expectQuote * 0.8, `delta=${makerTkbDelta}`)
      check(`[${chainId}] taker TKA increased`, takerTkaDelta >= Number(sizeStr) * 0.8, `delta=${takerTkaDelta}`)
    } else {
      console.log(
        `attempt ${attempt}: our maker order filled=${filledWei} (a same-price older order was likely matched first; retrying)`,
      )
    }
  }
  check(`[${chainId}] maker order filled == ${sizeStr} (on-chain)`, filledOk)

  // —— 第二阶段：部分成交 + 硬撤（独立价格避开同价队列）——
  const partialStr = trimNum(Number(sizeStr) / 2)
  const placed2 = await call(maker, 'place_order', {
    chainId,
    pair: PAIR,
    side: 'sell',
    price: PRICE2,
    amount: sizeStr,
  })
  check(`[${chainId}] maker place_order #2`, placed2.ok, placed2.error?.message ?? '')
  const digest2 = String(placed2.data?.digest ?? '')
  const matched2 = await call(taker, 'match_order', {
    chainId,
    pair: PAIR,
    side: 'buy',
    price: PRICE2,
    amount: partialStr,
  })
  check(
    `[${chainId}] taker partial match submitted`,
    matched2.ok && matched2.data?.status === 'submitted',
    `status=${matched2.data?.status} tx=${matched2.data?.txHash} msg=${matched2.data?.message ?? matched2.error?.message ?? ''}`,
  )
  const st2 = await callRead(maker, 'get_order_status', { chainId, digest: digest2 })
  check(
    `[${chainId}] partial filled == ${partialStr} and still locked`,
    st2.ok &&
      (st2.data?.filledIn as { wei: string })?.wei === weiOf(partialStr) &&
      st2.data?.locked === true,
    `filled=${JSON.stringify(st2.data?.filledIn)} locked=${st2.data?.locked}`,
  )
  const cancelled = await call(operator, 'hard_cancel_order', { chainId, digest: digest2 })
  check(
    `[${chainId}] operator hard_cancel_order`,
    cancelled.ok && cancelled.data?.cancelled === true,
    `tx=${cancelled.data?.txHash} code=${cancelled.error?.code} err=${cancelled.error?.message ?? ''}`,
  )
  const st3 = await callRead(maker, 'get_order_status', { chainId, digest: digest2 })
  check(
    `[${chainId}] tombstone set + lock released`,
    st3.ok && st3.data?.cancelled === true && st3.data?.locked === false,
    `cancelled=${st3.data?.cancelled} locked=${st3.data?.locked}`,
  )
}

async function runNegatives(maker: Client): Promise<void> {
  console.log(`\n===== negatives (chain ${chains[0]}) =====`)
  const chainId = chains[0]
  const bad1 = await call(maker, 'place_order', {
    chainId: 1,
    pair: PAIR,
    side: 'sell',
    price: PRICE,
    amount: '0.5',
  })
  check('mainnet chainId rejected', !bad1.ok && bad1.error?.code === 'chain_not_allowed', bad1.error?.code)

  const bad2 = await call(maker, 'place_order', {
    chainId,
    pair: 'PEPE/USDT',
    side: 'sell',
    price: PRICE,
    amount: '0.5',
  })
  check('non-allowlist pair rejected', !bad2.ok && bad2.error?.code === 'pair_not_allowed', bad2.error?.code)

  const capped = await startAgent(fixtures.find((f) => f.id === 'capped-e2e')!)
  const bad3 = await call(capped, 'place_order', {
    chainId,
    pair: PAIR,
    side: 'sell',
    price: PRICE,
    amount: '0.5',
  })
  check('over per-order cap rejected', !bad3.ok && bad3.error?.code === 'over_per_order_cap', bad3.error?.code)
  await capped.close()

  const disabled = await startAgent(fixtures.find((f) => f.id === 'disabled-e2e')!)
  const bad4 = await call(disabled, 'place_order', {
    chainId,
    pair: PAIR,
    side: 'buy',
    price: PRICE,
    amount: '0.5',
  })
  check('disabled agent write rejected', !bad4.ok && bad4.error?.code === 'agent_disabled', bad4.error?.code)
  const readOk = await call(disabled, 'get_chain_config', { chainId })
  check('disabled agent read still works', readOk.ok)
  await disabled.close()

  const killed = await startAgent(fixtures.find((f) => f.id === 'taker-e2e')!, {
    BIT100_MCP_KILL_SWITCH: '1',
  })
  const bad5 = await call(killed, 'place_order', {
    chainId,
    pair: PAIR,
    side: 'buy',
    price: PRICE,
    amount: '0.5',
  })
  check('kill switch: write rejected', !bad5.ok && bad5.error?.code === 'kill_switch_on', bad5.error?.code)
  const book = await call(killed, 'get_orderbook', { chainId, pair: PAIR })
  check('kill switch: read still works', book.ok)
  await killed.close()
}

async function main(): Promise<void> {
  console.log(`bit100-mcp E2E: chains=${chains.join(',')} keysDir=${keysDir} registry=${registryPath}`)
  const maker = await startAgent(fixtures[0])
  const taker = await startAgent(fixtures[1])
  const operator = await startAgent(fixtures[2])
  try {
    const tools = await maker.listTools()
    console.log(`tools: ${tools.tools.map((t) => t.name).join(', ')}`)
    for (const chainId of chains) {
      await runChain(chainId, maker, taker, operator)
    }
    await runNegatives(maker)
  } finally {
    await maker.close()
    await taker.close()
    await operator.close()
  }
  console.log(`\n===== E2E ${failures.length === 0 ? 'ALL PASS' : `FAILURES: ${failures.length}`} =====`)
  for (const f of failures) console.log(`FAILED: ${f}`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('E2E driver crashed:', e)
  process.exit(2)
})
