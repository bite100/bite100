/**
 * 第 50 轮故障注入自检入口：与 soak 的 timing.entry.ts 同法，只做
 * 再导出——供 faults.test.mjs 用仓库既有 esbuild（与 build.mjs 同
 * 一路）打包后在 Node 里驱动 engine 的账本/恢复/对账逻辑。测试
 * 全部走结构假件（假 provider/假 settlementRead），不连真链、
 * 不读密钥。
 */
export {
  Stage4Ledger,
  PendingLedgerCorruptError,
  recoverPendingSettlements,
  reconcileAfterTimeout,
} from './engine'
export { SETTLEMENT_ABI } from '../../src/services/settlementAbi'
