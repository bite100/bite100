/**
 * 金额上限字段的格式规则（无运行时依赖的叶子模块）。
 *
 * 第 59 轮起 stdio 注册表（agents.ts 的 zod schema）与 Worker D1 行
 * （worker/state.ts 的装配校验）共用同一条规则。第 57 轮 Worker 侧
 * 漏了这层校验：非数字 TEXT 经 Number() 变 NaN 后 `notional > NaN`
 * 恒假，两道金额护栏会静默失效（审计 ⑦）。
 *
 * 单独成文件的原因：worker/state.ts 对 agents.ts 只能做类型导入——
 * agents.ts 依赖 node:crypto/node:fs（注册表文件读取），一旦被值
 * 导入就会拖进 Workers 打包图（第 57 轮的既有纪律）。
 */

/** 合法格式：十进制数字字符串，至多一个小数点，小数点两侧都要有数字 */
export const QUOTE_AMOUNT_RE = /^\d+(\.\d+)?$/
