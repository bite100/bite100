#!/usr/bin/env node
/**
 * MCP server 打包：与 frontend/scripts/stage4/build.mjs 同法——esbuild 把
 * TS 源码（含复用的 frontend 生产模块）打成单个 Node ESM 文件；
 * import.meta.env define 成空对象（前端 config.ts 的浏览器环境变量在
 * Node 侧一律走显式注入，不依赖它）。
 * 产物：dist/bit100-mcp.mjs（server 本体，stdio）、dist/bit100-mcp-e2e.mjs（自练驱动）。
 */
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  define: { 'import.meta.env': '{}' },
  banner: {
    js: "import { createRequire as __mcpCreateRequire } from 'node:module'; const require = __mcpCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
}

await build({
  ...common,
  entryPoints: [join(here, 'src/index.ts')],
  outfile: join(here, 'dist/bit100-mcp.mjs'),
})
console.log('mcp bundles written to dist/')
