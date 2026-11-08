/**
 * 第 36 轮 N4 计时自检的打包入口：只重导出提交路径与记账类，
 * 供 timing.test.mjs 用仓库既有 esbuild 打成 Node 产物后以 fetch
 * 桩驱动（不连真实网络、不读密钥目录）。
 */
export { submitBatch, submitOrder } from './generator'
export type { GeneratedOrder, SubmitOutcome } from './generator'
export { SoakLedger } from './runner'
