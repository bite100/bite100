// 前端 config.ts 在模块加载时读 import.meta.env（浏览器构建注入）。
// Node 侧由 build.mjs 的 esbuild define 把它替换成空对象（与 stage4
// 运行器同法）；这里只给 tsc 一个类型声明。
interface ImportMeta {
  env: Record<string, string | undefined>
}
