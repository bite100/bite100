/**
 * Workers 形态打包：src/worker/entry.ts → worker-dist/worker.mjs
 * （单文件 ES module，供 custom.cloudflare 连接器的 upload-script 直传）。
 *
 * 与 Node 版 build.mjs 的区别：platform=node 让全部 node 内置模块
 * 外置（ethers 的 ws 传递依赖、SDK 的 ajv 等都按 node 口径解析），
 * 部署时开 nodejs_compat、由 Workers 运行时提供这些内置模块；
 * import.meta.env 同 Node 版以 define 置空对象（前端 config 的
 * 浏览器注入点）。
 */
import * as esbuild from 'esbuild'
import { mkdirSync } from 'node:fs'

mkdirSync('worker-dist', { recursive: true })

// Workers 的 nodejs_compat 只认 node: 前缀的内置模块说明符；传递依赖
// （ws/ethers 的 CJS 代码）里有裸 'http'/'crypto' 等写法， wrangler 会
// 自动改写、自研打包则用这个 onResolve 插件补上同一件事。
const BARE_BUILTINS = new Set([
  'http', 'https', 'net', 'tls', 'zlib', 'crypto', 'fs', 'path', 'os',
  'util', 'stream', 'events', 'buffer', 'url', 'querystring', 'dns',
  'assert', 'module', 'process', 'http2', 'perf_hooks', 'async_hooks',
  'string_decoder', 'punycode', 'constants', 'child_process', 'worker_threads',
])
const nodePrefixPlugin = {
  name: 'node-prefix',
  setup(build) {
    build.onResolve({ filter: /^[a-z_][a-z0-9_]*$/ }, (args) =>
      BARE_BUILTINS.has(args.path) ? { path: `node:${args.path}`, external: true } : undefined,
    )
  },
}

await esbuild.build({
  entryPoints: ['src/worker/entry.ts'],
  bundle: true,
  format: 'esm',
  // platform=browser 关键：让 ethers 走它的 browser 导出面——geturl
  // 换成 fetch 实现、IpcSocketProvider 被剔除，node:http/https/net/
  // zlib 导入整链消失（实测本账号 Workers 上传校验不接受 node:http）。
  platform: 'browser',
  target: 'es2022',
  minify: true,
  plugins: [nodePrefixPlugin],
  alias: {
    // ws 打桩：见 src/worker/stubs/ws.mjs 的说明
    ws: './src/worker/stubs/ws.mjs',
    // ethers 去重：frontend 与 mcp 各有一份 node_modules/ethers
    // （同为 6.17.0），不别名会打进去两份；统一到 mcp 这份。
    ethers: './node_modules/ethers',
    // node:fs / node:process 打桩：打包图里仅剩这两处 node: 导入
    // （signers 的文件读、SDK stdio 的 process），Workers 路径都不会
    // 真调用；上传校验不接受任何 node: 说明符，故桩进 bundle。
    'node:fs': './src/worker/stubs/node-fs.mjs',
    'node:process': './src/worker/stubs/node-process.mjs',
  },
  define: { 'import.meta.env': '{}' },
  outfile: 'worker-dist/worker.mjs',
  logLevel: 'info',
})

console.log('worker bundle written to worker-dist/')
