/**
 * Cloudflare Workers 运行时的最小类型声明（只声明本包实际用到的面）。
 * 不引 @cloudflare/workers-types 整包：mcp 包的 Node 侧以 @types/node
 * 为准，Workers 侧文件（src/worker/）只需要 D1 与 ExecutionContext
 * 这几个结构类型，手写最小声明避免两套全局类型互相污染。
 */
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  run(): Promise<{ success: boolean }>
}

interface D1Database {
  prepare(query: string): D1PreparedStatement
  batch(statements: D1PreparedStatement[]): Promise<unknown>
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException(): void
}

/** Worker 服务绑定（service binding）的最小形状：按 URL 直调另一个 Worker */
interface Fetcher {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
}
