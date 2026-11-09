/**
 * 'node:fs' 的 Workers 打包打桩（第 57 轮）：Workers 没有文件系统，
 * 本账号的脚本上传校验也不接受 node:fs 导入。Workers 形态下注册表、
 * 审计、签名钥全部走 D1/secret 绑定（state.ts / signers 注入钩子），
 * 永远不会调用 fs；留这个桩只是让 signers.ts 的模块级 import 能加载。
 * 任何函数被真调用时立即抛错——响亮失败，好过静默错行为。
 */
function unavailable(name) {
  return () => {
    throw new Error(`node:fs.${name} is not available in the Workers build`)
  }
}

export const readFileSync = unavailable('readFileSync')
export const appendFileSync = unavailable('appendFileSync')
export const writeFileSync = unavailable('writeFileSync')
export const mkdirSync = unavailable('mkdirSync')
export const existsSync = () => false

export default { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync }
