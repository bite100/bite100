#!/usr/bin/env node
/**
 * 挂单计量 CLI 打包（第 42 轮 块 B）：骑乘压测同款 esbuild 模式
 * （scripts/soak/build.mjs），把 main.ts 打成单个 Node ESM 文件。
 */
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [join(here, 'main.ts')],
  outfile: join(here, 'dist', 'posting-meter.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'info',
})
console.log('posting-meter bundle written to dist/posting-meter.mjs')
