#!/usr/bin/env node
// 阶段 3 双路 E2E 打包（第 43 轮多腿驱动复用同一模式）：esbuild 把
// driver.ts（D1 单腿）与 driver-multileg.ts（第 43 轮）打成单文件 dist/*.mjs。
// driver 复用 src 下的生产撮合/摘要/双读逻辑，需要 import.meta.env 替身
// （与 soak/build.mjs 同口径）；ethers 依赖 ws，用 createRequire 横幅兜底。
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'dist')
mkdirSync(out, { recursive: true })

for (const name of ['driver', 'driver-multileg']) {
  await build({
    entryPoints: [join(here, `${name}.ts`)],
    outfile: join(out, `${name}.mjs`),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    define: { 'import.meta.env': '{}' },
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  })
  console.log(`built dist/${name}.mjs`)
}
