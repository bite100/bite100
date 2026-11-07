import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll } from 'vitest'

// 在每个测试文件前把 migrations/ 的全部迁移应用到本地 D1
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS as never)
})
