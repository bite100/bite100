/**
 * bit100-mcp Worker 部署脚本（第 57 轮）：经 custom.cloudflare 连接器
 * 的 cf_api.py 完成——建 D1（bit100-mcp）→ 跑 migrations → 上传脚本
 * （绑定只含 D1；secret 不进上传 metadata）→ 经 secrets 子集合写入
 * 三个角色测试钥 → 开 workers.dev 子域。
 *
 * 私钥纪律：测试钥从 ~/workspace/bite100-deployer/*.env 在本进程内
 * 读取，请求体经 /tmp 的 0600 临时文件传递、用完即删；脚本输出只打
 * 密钥的名字与 HTTP 状态，绝不打印任何密钥值。
 *
 * 用法：node worker/deploy.mjs（在 mcp/ 目录下；先 node build-worker.mjs）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ACCOUNT = '400bb171abd29b2362600dd677c5eca8'
const SCRIPT = 'bit100-mcp'
const DB_NAME = 'bit100-mcp'
const HELPER = join(homedir(), 'workspace/custom-connectors/custom.cloudflare/bin/cf_api.py')
const KEYS_DIR = join(homedir(), 'workspace/bite100-deployer')

function cf(args, { okStatuses = [200] } = {}) {
  const out = execFileSync('python3', [HELPER, ...args], { encoding: 'utf8' })
  const nl = out.indexOf('\n')
  const status = Number(out.slice(0, nl).replace('HTTP ', '').trim())
  const bodyText = out.slice(nl + 1)
  let body = null
  try {
    body = JSON.parse(bodyText)
  } catch {
    /* 非 JSON 响应保留原文 */
  }
  if (!okStatuses.includes(status)) {
    throw new Error(`cf ${args.slice(0, 3).join(' ')} → HTTP ${status}: ${bodyText.slice(0, 300)}`)
  }
  return { status, body, bodyText }
}

function cfJson(method, path, data, opts) {
  const tmp = join('/tmp', `cf-body-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`)
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
  try {
    return cf(['request', method, path, '--data', tmp], opts)
  } finally {
    try {
      unlinkSync(tmp)
    } catch {}
  }
}

function main() {
  // 0) 先证明凭据可用（无害读）
  const scripts = cf(['request', 'GET', `/client/v4/accounts/${ACCOUNT}/workers/scripts`])
  console.log(`access ok: ${scripts.body?.result?.length ?? 0} worker scripts visible`)

  // 1) D1：找现有或新建
  const list = cf(['request', 'GET', `/client/v4/accounts/${ACCOUNT}/d1/database`])
  let db = (list.body?.result ?? []).find((d) => d.name === DB_NAME)
  if (!db) {
    const created = cfJson('POST', `/client/v4/accounts/${ACCOUNT}/d1/database`, { name: DB_NAME })
    db = created.body?.result
    console.log(`d1 created: ${DB_NAME} id=${db?.uuid ?? db?.id}`)
  } else {
    console.log(`d1 exists: ${DB_NAME} id=${db.uuid ?? db.id}`)
  }
  const dbId = db.uuid ?? db.id
  if (!dbId) throw new Error('D1 id missing from API response')

  // 2) migrations：0001 幂等（IF NOT EXISTS / INSERT OR IGNORE）；
  // 0002 含 ALTER TABLE ADD COLUMN（SQLite 无 IF NOT EXISTS 写法），
  // 重复执行时只容忍 duplicate column 错误，其余照常抛。
  const sql = readFileSync(new URL('./migrations/0001_init.sql', import.meta.url), 'utf8')
  cfJson('POST', `/client/v4/accounts/${ACCOUNT}/d1/database/${dbId}/query`, { sql })
  const sql2 = readFileSync(new URL('./migrations/0002_r59_register.sql', import.meta.url), 'utf8')
  try {
    cfJson('POST', `/client/v4/accounts/${ACCOUNT}/d1/database/${dbId}/query`, { sql: sql2 })
    console.log('d1 migrations applied (0001 + 0002)')
  } catch (e) {
    if (/duplicate column/i.test(e instanceof Error ? e.message : String(e))) {
      console.log('d1 migrations applied (0001; 0002 already present)')
    } else {
      throw e
    }
  }

  // 3) 上传脚本（metadata 只带 D1 绑定；secret 绝不进上传体）
  if (!existsSync('worker-dist/worker.mjs')) throw new Error('worker-dist/worker.mjs 不存在：先跑 node build-worker.mjs')
  const metadata = {
    main_module: 'worker.mjs',
    compatibility_date: '2025-01-01',
    compatibility_flags: ['nodejs_compat'],
    bindings: [
      { type: 'd1', name: 'DB', id: dbId },
      // 到中继的服务绑定：Worker 内全局 fetch 打 workers.dev 会 1042
      { type: 'service', name: 'RELAY', service: 'bit100-relay' },
    ],
  }
  const metaPath = join('/tmp', `cf-meta-${process.pid}.json`)
  writeFileSync(metaPath, JSON.stringify(metadata), { mode: 0o600 })
  try {
    const up = cf(['upload-script', SCRIPT, '--bundle', 'worker-dist/worker.mjs', '--metadata', metaPath], {
      okStatuses: [200, 201],
    })
    console.log(`script uploaded: HTTP ${up.status}`)
  } finally {
    try {
      unlinkSync(metaPath)
    } catch {}
  }

  // 4) 角色测试钥 → secrets 子集合（值只在本进程与临时请求体里出现）
  const keyMap = [
    ['KEY_MAKER', 'maker.env'],
    ['KEY_TAKER', 'taker.env'],
    ['KEY_OPERATOR', 'wallet.env'],
  ]
  for (const [name, file] of keyMap) {
    const text = readFileSync(join(KEYS_DIR, file), 'utf8')
    const m = text.match(/0x[0-9a-fA-F]{64}/)
    if (!m) throw new Error(`${file} 中未找到私钥（只报存在性，不打印内容）`)
    const res = cfJson(
      'PUT',
      `/client/v4/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/secrets`,
      { name, text: m[0], type: 'secret_text' },
      { okStatuses: [200, 201] }, // 新建 secret 回 201、更新回 200
    )
    console.log(`secret ${name}: HTTP ${res.status}`)
  }

  // 5) 开 workers.dev 子域
  const sub = cfJson('POST', `/client/v4/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/subdomain`, { enabled: true })
  console.log(`subdomain enabled: HTTP ${sub.status}`)
  console.log(`URL: https://${SCRIPT}.q3874758.workers.dev`)
}

main()
