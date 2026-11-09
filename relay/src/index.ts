/**
 * 比特100 订单公告栏中继（无节点化阶段 1 · 候选 A：Cloudflare Workers + D1）
 *
 * 定位：哑公告栏——只存与转签名订单，不撮合、不排序裁决、不记成交状态，
 * 无用户私钥、无资金经手（设计见主仓库 docs/nodeless-design-2026-11-07.md §1/§2）。
 * 入库三条共同前提：入库验签（EIP-712 + expiresAt）、按 digest 去重、订单可移植
 * （raw_json 存原文，换中继重发同一份即可）。
 *
 * 接口（与节点 REST 对齐，见 README 接口表）：
 *   POST /orders     同节点 POST /api/order 的请求体（另加可选 chainId）
 *   GET  /orders     ?chain=&pair=&userAddress=(或 trader=)&limit=
 *   GET  /orderbook  ?pair=&chain=
 *   GET  /health
 *   POST /pairs      自助上架注册（第六十轮）：{chainId, baseToken, quoteToken, creator?}，
 *                    元数据由中继链上复读、不信任提交方；幂等
 *   GET  /pairs      ?chain= 列某链的自助上架对（种子 8 对走内置配置、不在此列）
 */
import { DEFAULT_CHAIN_ID, resolveChains, type ChainRelayConfig } from './config'
import {
  buildSignedOrderWithTokens,
  orderDigest,
  validateBody,
  verifyOrder,
  type NodeOrderBody,
} from './orders'
import {
  PairRequestError,
  listPairs,
  registerPair,
  resolveOrderTokens,
  type PairRow,
} from './pairs'
import {
  buildOrderEvent,
  parsePostmanSecret,
  publishToRelays,
  resolveRelayUrls,
} from './nostr'

export interface Env {
  DB: D1Database
  /** 可选：整体覆盖内置链配置（Settlement 换地址时用），见 config.ts */
  CHAIN_CONFIG_JSON?: string
  /** 可选：覆盖内置公共 RPC（ERC-1271 验签回退用） */
  SEPOLIA_RPC_URL?: string
  BASE_SEPOLIA_RPC_URL?: string
  /** Nostr 邮差私钥（hex 或 nsec）；只经 secret / .dev.vars 注入，绝不写进仓库 */
  NOSTR_POSTMAN_SECRET_HEX?: string
  NOSTR_RELAYS?: string
  NOSTR_KIND?: string
}

interface OrderRow {
  digest: string
  chain_id: number
  order_id: string
  user_address: string
  pair: string
  side: string
  price: string
  amount: string
  filled: string
  status: string
  nonce: number
  created_at: number
  expires_at: number
  exec_type: string | null
  signature: string
  nostr_event_id: string | null
}

/** D1 行 -> 节点 storage.Order 的 JSON 形状（另加 chainId/digest/nostrEventId 扩展字段） */
function rowToOrder(r: OrderRow) {
  const o: Record<string, unknown> = {
    orderId: r.order_id,
    trader: r.user_address,
    pair: r.pair,
    side: r.side,
    price: r.price,
    amount: r.amount,
    filled: r.filled,
    status: r.status,
    nonce: r.nonce,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    signature: r.signature,
    chainId: r.chain_id,
    digest: r.digest,
    nostrEventId: r.nostr_event_id,
  }
  if (r.exec_type) o.execType = r.exec_type
  return o
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

function textError(message: string, status: number): Response {
  return new Response(message, { status, headers: { ...CORS } })
}

function parseLimit(raw: string | null, def: number, max: number): number {
  if (!raw) return def
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 && n <= max ? n : def
}

function parseChainParam(url: URL): number | null {
  const raw = url.searchParams.get('chain') ?? url.searchParams.get('chainId')
  if (raw === null || raw === '') return null
  const n = Number(raw)
  return Number.isInteger(n) ? n : NaN
}

/** 解析生效链配置（/orders 与 /pairs 共用）；失败返回 null（调用方回 500） */
function loadChains(env: Env): Record<number, ChainRelayConfig> | null {
  try {
    const rpcOverrides: Record<number, string> = {}
    if (env.SEPOLIA_RPC_URL) rpcOverrides[11155111] = env.SEPOLIA_RPC_URL
    if (env.BASE_SEPOLIA_RPC_URL) rpcOverrides[84532] = env.BASE_SEPOLIA_RPC_URL
    return resolveChains(env.CHAIN_CONFIG_JSON, rpcOverrides)
  } catch (e) {
    console.error('[relay] chain config error', e)
    return null
  }
}

async function handlePostOrder(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return textError('invalid json', 400)
  }
  let body: NodeOrderBody
  try {
    body = validateBody(raw)
  } catch (e) {
    return textError(e instanceof Error ? e.message : 'invalid order', 400)
  }
  const chainId = body.chainId ?? DEFAULT_CHAIN_ID
  const chains = loadChains(env)
  if (!chains) return textError('relay chain config error', 500)
  const chain = chains[chainId]
  if (!chain) return textError(`unsupported chain: ${chainId}`, 400)

  // 代币解析：种子符号键走内置表；自助上架的地址型键查注册表（pairs.ts）
  const tokens = await resolveOrderTokens(env.DB, chain, body.pair)
  if (!tokens) return textError(`unknown pair: ${body.pair}`, 400)
  const so = buildSignedOrderWithTokens(tokens, body)

  const now = Math.floor(Date.now() / 1000)
  // 过期防护（与节点 OrderExpired 同口径：now > expiresAt 即拒）
  if (now > Number(so.expiresAt)) return textError('order expired', 400)

  const valid = await verifyOrder(chain, so, body.signature)
  if (!valid) return textError('invalid signature', 401)

  const digest = orderDigest(chain, so)
  const rawJson = JSON.stringify(raw)
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO orders
       (digest, chain_id, order_id, user_address, pair, side, price, amount, amount_out,
        token_in, token_out, filled, status, nonce, created_at, expires_at, exec_type,
        signature, raw_json, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      digest,
      chainId,
      body.orderId,
      body.trader.toLowerCase(),
      body.pair,
      body.side,
      body.price,
      body.amount,
      so.amountOut.toString(),
      so.tokenIn,
      so.tokenOut,
      body.filled ?? '0',
      body.status ?? 'open',
      body.nonce,
      body.createdAt,
      Number(so.expiresAt),
      body.execType ?? null,
      body.signature,
      rawJson,
      now,
    )
    .run()

  const inserted = (res.meta.changes ?? 0) > 0
  if (!inserted) {
    // 重复投递：返回已存在，不报错（便签可多源重发，去重靠 digest 主键）
    return json({ ok: true, orderId: body.orderId, digest, duplicate: true })
  }

  // Nostr 并行镜像：best-effort，waitUntil 后台发，不阻塞入库响应；
  // 成功才回填 nostr_event_id，失败只记日志。
  ctx.waitUntil(
    (async () => {
      try {
        const secret = parsePostmanSecret(env.NOSTR_POSTMAN_SECRET_HEX)
        if (!secret) return // 未配置邮差密钥：跳过镜像（主入库不受影响）
        const kind = Number(env.NOSTR_KIND ?? '') || 30078
        const event = buildOrderEvent(
          {
            rawJson,
            digest,
            pair: body.pair,
            chainId,
            expiresAt: Number(so.expiresAt),
          },
          secret,
          kind,
        )
        const mirrored = await publishToRelays(event, resolveRelayUrls(env.NOSTR_RELAYS))
        if (mirrored) {
          await env.DB.prepare('UPDATE orders SET nostr_event_id = ? WHERE digest = ?')
            .bind(mirrored.eventId, digest)
            .run()
          console.log(`[relay] nostr mirror ok digest=${digest} relay=${mirrored.relay}`)
        } else {
          console.warn(`[relay] nostr mirror failed (best-effort) digest=${digest}`)
        }
      } catch (e) {
        console.warn('[relay] nostr mirror error (best-effort)', e)
      }
    })(),
  )

  return json({ ok: true, orderId: body.orderId, digest })
}

async function handleGetOrders(url: URL, env: Env): Promise<Response> {
  const chainParam = parseChainParam(url)
  if (chainParam !== null && Number.isNaN(chainParam)) return textError('invalid chain', 400)
  const pair = url.searchParams.get('pair') ?? ''
  const user = (
    url.searchParams.get('userAddress') ??
    url.searchParams.get('trader') ??
    ''
  ).toLowerCase()
  const limit = parseLimit(url.searchParams.get('limit'), 50, 200)
  const now = Math.floor(Date.now() / 1000)

  let sql =
    'SELECT * FROM orders WHERE expires_at > ?' // 过期下架：查询时过滤
  const binds: unknown[] = [now]
  if (chainParam !== null) {
    sql += ' AND chain_id = ?'
    binds.push(chainParam)
  }
  if (pair !== '') {
    sql += ' AND pair = ?'
    binds.push(pair)
  }
  if (user !== '') {
    sql += ' AND user_address = ?'
    binds.push(user)
  }
  sql += ' ORDER BY created_at DESC LIMIT ?'
  binds.push(limit)

  const { results } = await env.DB.prepare(sql)
    .bind(...binds)
    .all<OrderRow>()
  return json((results ?? []).map(rowToOrder))
}

function comparePrice(a: string, b: string): number {
  const x = BigInt(a)
  const y = BigInt(b)
  return x < y ? -1 : x > y ? 1 : 0
}

async function handleOrderbook(url: URL, env: Env): Promise<Response> {
  const pair = url.searchParams.get('pair') ?? ''
  if (pair === '') return textError('pair required', 400)
  const chainParam = parseChainParam(url)
  if (chainParam !== null && Number.isNaN(chainParam)) return textError('invalid chain', 400)
  const chainId = chainParam ?? DEFAULT_CHAIN_ID
  const now = Math.floor(Date.now() / 1000)

  const { results } = await env.DB.prepare(
    `SELECT * FROM orders
      WHERE chain_id = ? AND pair = ? AND expires_at > ? AND status IN ('open', 'partial')
      ORDER BY created_at ASC LIMIT 400`,
  )
    .bind(chainId, pair, now)
    .all<OrderRow>()

  const bids: OrderRow[] = []
  const asks: OrderRow[] = []
  for (const r of results ?? []) {
    ;(r.side === 'buy' ? bids : asks).push(r)
  }
  // 价格-时间优先（与节点 ListOrdersOpenByPair 同口径）：买盘价降序、卖盘价升序，同价时间升序
  bids.sort((a, b) => comparePrice(b.price, a.price) || a.created_at - b.created_at)
  asks.sort((a, b) => comparePrice(a.price, b.price) || a.created_at - b.created_at)
  return json({
    pair,
    bids: bids.slice(0, 100).map(rowToOrder),
    asks: asks.slice(0, 100).map(rowToOrder),
  })
}

function pairRowJson(r: PairRow) {
  return {
    chainId: r.chainId,
    pairKey: r.pairKey,
    baseToken: r.baseToken,
    quoteToken: r.quoteToken,
    baseSymbol: r.baseSymbol,
    quoteSymbol: r.quoteSymbol,
    baseName: r.baseName,
    quoteName: r.quoteName,
    baseDecimals: r.baseDecimals,
    quoteDecimals: r.quoteDecimals,
    creator: r.creator,
    createdAt: r.createdAt,
  }
}

/** 自助上架注册（第六十轮）：元数据链上复读、幂等、基础限流，逻辑在 pairs.ts */
async function handleRegisterPair(request: Request, env: Env): Promise<Response> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return textError('invalid json', 400)
  }
  if (typeof raw !== 'object' || raw === null) return textError('invalid json body', 400)
  const b = raw as Record<string, unknown>
  const chainId =
    b.chainId === undefined ? DEFAULT_CHAIN_ID : Number(b.chainId)
  if (!Number.isInteger(chainId)) return textError('invalid chainId', 400)
  const chains = loadChains(env)
  if (!chains) return textError('relay chain config error', 500)
  const chain = chains[chainId]
  if (!chain) return textError(`unsupported chain: ${chainId}`, 400)
  try {
    const { row, duplicate } = await registerPair(env.DB, chain, {
      baseToken: typeof b.baseToken === 'string' ? b.baseToken : '',
      quoteToken: typeof b.quoteToken === 'string' ? b.quoteToken : '',
      creator: typeof b.creator === 'string' ? b.creator : null,
    })
    return json(
      { ok: true, pair: pairRowJson(row), ...(duplicate ? { duplicate: true } : {}) },
      duplicate ? 200 : 201,
    )
  } catch (e) {
    if (e instanceof PairRequestError) return textError(e.message, e.status)
    console.error('[relay] register pair error', e)
    return textError('internal server error', 500)
  }
}

/** 列某链的自助上架对（种子 8 对不在此列，前端本地合并） */
async function handleListPairs(url: URL, env: Env): Promise<Response> {
  const chainParam = parseChainParam(url)
  if (chainParam !== null && Number.isNaN(chainParam)) return textError('invalid chain', 400)
  const chainId = chainParam ?? DEFAULT_CHAIN_ID
  const rows = await listPairs(env.DB, chainId)
  return json(rows.map(pairRowJson))
}

async function handleHealth(env: Env): Promise<Response> {
  try {
    await env.DB.prepare('SELECT 1').first()
    return json({ ok: true, db: 'ok', time: Math.floor(Date.now() / 1000) })
  } catch (e) {
    console.error('[relay] health db error', e)
    return json({ ok: false, db: 'error', time: Math.floor(Date.now() / 1000) }, 503)
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS })
    try {
      switch (`${request.method} ${url.pathname}`) {
        case 'POST /orders':
          return await handlePostOrder(request, env, ctx)
        case 'GET /orders':
          return await handleGetOrders(url, env)
        case 'GET /orderbook':
          return await handleOrderbook(url, env)
        case 'POST /pairs':
          return await handleRegisterPair(request, env)
        case 'GET /pairs':
          return await handleListPairs(url, env)
        case 'GET /health':
          return await handleHealth(env)
        default:
          return textError('not found', 404)
      }
    } catch (e) {
      console.error('[relay] unhandled error', e)
      return textError('internal server error', 500)
    }
  },

  /** 过期清理：删掉过期超过 1 天的行（查询侧本就过滤，这里只控表体积） */
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600
    const res = await env.DB.prepare('DELETE FROM orders WHERE expires_at < ?')
      .bind(cutoff)
      .run()
    console.log(`[relay] expired cleanup removed ${res.meta.changes ?? 0} rows`)
  },
}
