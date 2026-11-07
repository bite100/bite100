import path from 'node:path'
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config'

/**
 * Worker 集成测试（workerd + miniflare 本地 D1）：走真实 fetch 入口与真实 SQL。
 * D1 migration 由 test/workers/setup.ts 经 applyD1Migrations 注入。
 */
export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, 'migrations'))
  return {
    test: {
      include: ['test/workers/**/*.test.ts'],
      setupFiles: ['test/workers/setup.ts'],
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.toml' },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              // 测试专用一次性邮差密钥（公开测试值，不是任何真实账户密钥）；
              // NOSTR_RELAYS 指向不可达地址：镜像必然失败且必须不阻塞入库
              NOSTR_POSTMAN_SECRET_HEX:
                '0000000000000000000000000000000000000000000000000000000000000001',
              NOSTR_RELAYS: 'ws://127.0.0.1:9',
              // ERC-1271 回退在测试里指向不可达地址：坏签名订单应快速 fail-closed 回 401，
              // 不依赖真实公共 RPC 的可用性
              SEPOLIA_RPC_URL: 'http://127.0.0.1:9',
              BASE_SEPOLIA_RPC_URL: 'http://127.0.0.1:9',
            },
          },
        },
      },
    },
  }
})
