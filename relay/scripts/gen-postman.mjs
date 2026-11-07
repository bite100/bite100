/**
 * 生成一次性 Nostr 邮差密钥（仅本地演示用），把 hex 私钥写入仓库外文件
 * （第一个参数，默认 /tmp/bit100-relay-postman.env），stdout 只打印公钥。
 * 私钥永不打印、永不写进仓库。生产环境请用 `wrangler secret put` 注入
 * 你自己保管的邮差密钥，不要用本脚本的演示密钥上线。
 * 用法：node scripts/gen-postman.mjs [输出文件]
 */
import { writeFileSync } from 'node:fs'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'

const out = process.argv[2] ?? '/tmp/bit100-relay-postman.env'
const sk = generateSecretKey()
const hex = Array.from(sk)
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('')
writeFileSync(out, `NOSTR_POSTMAN_SECRET_HEX=${hex}\n`, { mode: 0o600 })
console.log(`[gen-postman] postman pubkey (npub): ${nip19.npubEncode(getPublicKey(sk))}`)
console.log(`[gen-postman] secret written to ${out} (outside repo, mode 600, not printed)`)
