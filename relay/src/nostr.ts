/**
 * Nostr 并行镜像（best-effort 写扇出）：每张被主中继接受的订单，额外发布为
 * 一个 Nostr 事件到多个公共中继。订单真实性由其内嵌的 EIP-712 签名保证，
 * Nostr 密钥只是「邮差」身份——不被信任、不持任何用户密钥/资金，泄露也只能
 * 冒充邮差发便签，伪造不了订单（读端仍验 EIP-712 签名）。
 *
 * 事件方案（见 README）：
 *   kind = 30078（NIP-78 参数化可替换应用数据；可用 NOSTR_KIND 覆盖）
 *   tags: ["d", <order digest>]            —— 同一订单重复发布在 Nostr 侧自动收敛为同一条
 *         ["pair", <pair>] ["chain", <chainId>] ["exp", <expiresAt unix 秒>]
 *         ["expiration", <expiresAt unix 秒>] —— 第 59 轮块 4 起并行带上
 *         NIP-40 标准过期标签（审计 ⑤ 的最小修法）：支持 NIP-40 的中继
 *         会在到期后自行删除事件，"exp" 是中继自有标签、老读端不认，
 *         两者并存兼容；注意这仍不构成镜像侧的撤单墓碑——订单状态以
 *         链上为准（设计口径不变）。
 *   content = 投递原文 JSON（与 POST /orders 请求体一致，含签名）
 *
 * 邮差私钥只从环境变量 NOSTR_POSTMAN_SECRET_HEX（64 位 hex）读取（生产用
 * `wrangler secret put`，本地用 .dev.vars）；缺失时镜像静默跳过。
 * 发布失败只返回 null + 由调用方记日志，绝不阻塞主入库响应。
 */
import { finalizeEvent, nip19, Relay, type Event, type EventTemplate } from 'nostr-tools'

export const DEFAULT_NOSTR_KIND = 30078
export const DEFAULT_NOSTR_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
]

export interface MirrorResult {
  eventId: string
  relay: string
}

/** 解析邮差私钥：接受 64 位 hex 或 nsec1…（bech32）。非法返回 null（跳过镜像）。 */
export function parsePostmanSecret(secret: string | undefined): Uint8Array | null {
  if (!secret) return null
  const s = secret.trim()
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    const bytes = new Uint8Array(32)
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
    return bytes
  }
  if (s.startsWith('nsec1')) {
    try {
      const decoded = nip19.decode(s)
      if (decoded.type === 'nsec') return decoded.data as Uint8Array
    } catch {
      return null
    }
  }
  return null
}

export interface MirrorInput {
  rawJson: string
  digest: string
  pair: string
  chainId: number
  expiresAt: number
}

/** 组装并签名订单镜像事件（纯函数，可单测） */
export function buildOrderEvent(
  input: MirrorInput,
  secretKey: Uint8Array,
  kind: number = DEFAULT_NOSTR_KIND,
  createdAt: number = Math.floor(Date.now() / 1000),
): Event {
  const template: EventTemplate = {
    kind,
    created_at: createdAt,
    tags: [
      ['d', input.digest],
      ['pair', input.pair],
      ['chain', String(input.chainId)],
      ['exp', String(input.expiresAt)],
      ['expiration', String(input.expiresAt)],
    ],
    content: input.rawJson,
  }
  return finalizeEvent(template, secretKey)
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])
}

/**
 * 向一个中继发布事件：连上并被中继接受（OK）才算成功。
 * 发布函数可注入（单测用 mock relay / 本地 ws 假中继走同一代码路径）。
 */
export type PublishFn = (relayUrl: string, event: Event, timeoutMs: number) => Promise<void>

export const nostrToolsPublish: PublishFn = async (relayUrl, event, timeoutMs) => {
  const relay = await withTimeout(Relay.connect(relayUrl), timeoutMs)
  try {
    await withTimeout(relay.publish(event), timeoutMs)
  } finally {
    relay.close()
  }
}

/**
 * 把事件扇出到多个中继：逐个尝试，任一成功即返回其 event id 与中继名；
 * 全部失败返回 null。best-effort 语义在调用方：本函数永不抛错。
 */
export async function publishToRelays(
  event: Event,
  relayUrls: string[],
  opts: { timeoutMs?: number; publish?: PublishFn } = {},
): Promise<MirrorResult | null> {
  const timeoutMs = opts.timeoutMs ?? 5000
  const publish = opts.publish ?? nostrToolsPublish
  for (const url of relayUrls) {
    try {
      await publish(url, event, timeoutMs)
      return { eventId: event.id, relay: url }
    } catch {
      // 单个中继失败继续下一个；全部失败由调用方记日志
    }
  }
  return null
}

/** 解析 NOSTR_RELAYS 变量（逗号分隔），为空回默认公共中继列表 */
export function resolveRelayUrls(csv: string | undefined): string[] {
  if (!csv) return DEFAULT_NOSTR_RELAYS
  const urls = csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('ws://') || s.startsWith('wss://'))
  return urls.length > 0 ? urls : DEFAULT_NOSTR_RELAYS
}
