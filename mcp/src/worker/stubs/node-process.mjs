/**
 * 'node:process' 的 Workers 打包打桩（第 57 轮）：官方 SDK 的
 * server/stdio.js（经 server.ts 的 serveStdio 进入打包图）在模块级
 * `import process from 'node:process'`，只在构造 StdioServerTransport
 * 时用 stdin/stdout——Workers 形态从不构造它，但上传校验不接受
 * node:process 导入，故打桩。env 给空对象：万一有代码读
 * process.env.*，拿到的是「未设置」而不是崩溃（killSwitchOn 等
 * Node 口径在 Workers 形态已被 D1 状态层替代，不走这条路）。
 */
const proc = {
  env: {},
  pid: 0,
  version: 'v0.0.0-workers-stub',
  versions: {},
  platform: 'browser',
  arch: 'wasm32',
  stdin: undefined,
  stdout: undefined,
  stderr: undefined,
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
  cwd: () => '/',
  exit: (code) => {
    throw new Error(`process.exit(${code ?? 0}) called in the Workers build`)
  },
  on: () => proc,
  off: () => proc,
  listeners: () => [],
}

export default proc
