#!/usr/bin/env node
/**
 * 合成压测打包（第 35 轮 D-10）：用仓库既有 esbuild（vite 依赖）把
 * scripts/soak/*.ts 打成单个 Node ESM 文件 dist/soak.mjs。
 *
 * import.meta.env 处理：dualread 的模块图会读 import.meta.env.VITE_*，
 * 打包时统一 define 成空对象字面量（服务端行为不依赖浏览器环境变量：
 * 适配器与节点/中继地址全部由 runner 显式注入，RELAY_MODE 的模块级
 * 常量在服务端不参与判定——runDualReadRound 的 mode 由 deps 注入）。
 */
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [join(here, 'main.ts')],
  outfile: join(here, 'dist', 'soak.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  define: {
    'import.meta.env': '{}',
  },
  banner: {
    // ethers 的传递依赖（ws）用 CJS require 加载 node 内置模块，
    // ESM 产物需 createRequire 垫片（esbuild 官方推荐做法）
    js: "import { createRequire as __soakCreateRequire } from 'node:module'; const require = __soakCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
})
console.log('soak bundle written to dist/soak.mjs')
