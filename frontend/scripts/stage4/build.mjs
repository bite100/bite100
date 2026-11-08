#!/usr/bin/env node
/**
 * 阶段 4 运行器打包：与 soak 的 build.mjs 同法——仓库既有 esbuild
 * （vite 依赖）把 scripts/stage4/*.ts 打成单个 Node ESM 文件
 * dist/stage4.mjs；import.meta.env 统一 define 成空对象（服务端行为
 * 不依赖浏览器环境变量：地址/适配器全部由 engine 显式注入，
 * runDualReadRound 的 mode 由调用方注入）。
 */
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [join(here, 'main.ts')],
  outfile: join(here, 'dist', 'stage4.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  define: {
    'import.meta.env': '{}',
  },
  banner: {
    js: "import { createRequire as __s4CreateRequire } from 'node:module'; const require = __s4CreateRequire(import.meta.url);",
  },
  logLevel: 'info',
})
console.log('stage4 bundle written to dist/stage4.mjs')
