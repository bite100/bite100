#!/usr/bin/env node
/**
 * 第 60 轮 E2E 打包：与 scripts/stage4/build.mjs 同法——仓库既有 esbuild
 * 把 run.ts 打成单个 Node ESM 文件 dist/round60-e2e.mjs；
 * import.meta.env 统一 define 成空对象（链/合约地址全部取自 src 的
 * 静态配置；中继地址由 R60_RELAY_URL 环境变量在运行时注入适配器与
 * primeListedPair，不依赖构建期环境变量）。
 */
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [join(here, 'run.ts')],
  outfile: join(here, 'dist', 'round60-e2e.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  define: {
    'import.meta.env': '{}',
  },
  banner: {
    js: "import { createRequire as __r60CreateRequire } from 'node:module'; const require = __r60CreateRequire(import.meta.url);",
  },
  logLevel: 'info',
})
console.log('round60 e2e bundle written to dist/round60-e2e.mjs')
