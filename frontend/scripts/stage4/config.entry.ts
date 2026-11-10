/**
 * 第 59 轮配置解析自检入口：与 faults.entry.ts 同法，只做再导出——
 * 供 config.test.mjs 用仓库既有 esbuild 打包后在 Node 里驱动
 * engine 的 S4_CHAINS / S4_PAIRS 环境解析与代表对选择规则。
 * 纯函数自检：不连真链、不读密钥、不改运行器缺省行为。
 */
export { CHAINS, parseChains, parseCsvList, parsePairs, pickCheckPair } from './engine'
export { DEFAULT_PAIR, TRADE_PAIRS } from '../../src/config/pairs'
