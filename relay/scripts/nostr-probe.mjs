/**
 * 公共 Nostr 中继真实发布探针：用一次性邮差密钥把一张演示订单事件分别发到
 * relay.damus.io / nos.lol / relay.nostr.band，逐个记录连通与发布结果。
 * 本 VM 出口经代理、wss 直连可能不通——不通就如实记录，绝不伪造成功。
 * 用法：node scripts/nostr-probe.mjs
 */
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, Relay } from 'nostr-tools'

const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band']
const TIMEOUT_MS = 12000

const sk = generateSecretKey()
console.log(`[probe] ephemeral postman pubkey: ${nip19.npubEncode(getPublicKey(sk))}`)

const event = finalizeEvent(
  {
    kind: 30078,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', '0x' + '00'.repeat(32)],
      ['pair', 'BTC/USDT'],
      ['chain', '11155111'],
      ['exp', String(Math.floor(Date.now() / 1000) + 3600)],
    ],
    content: JSON.stringify({ probe: 'bit100-relay', note: 'connectivity probe, not a real order' }),
  },
  sk,
)
console.log(`[probe] event id: ${event.id}`)

function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms)),
  ])
}

for (const url of RELAYS) {
  const t0 = Date.now()
  try {
    const relay = await withTimeout(Relay.connect(url), TIMEOUT_MS, 'connect')
    try {
      await withTimeout(relay.publish(event), TIMEOUT_MS, 'publish')
      console.log(`[probe] OK   ${url} published in ${Date.now() - t0}ms`)
    } finally {
      relay.close()
    }
  } catch (e) {
    console.log(`[probe] FAIL ${url} after ${Date.now() - t0}ms: ${e.message}`)
  }
}
