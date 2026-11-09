/**
 * 工具错误口径：一切工具失败都返回结构化错误（MCP isError 结果，
 * content 里是一段 JSON：{ok:false, error:{code, message}}），不抛裸
 * 异常给客户端。成功结果同理统一为 {ok:true, data:{...}} 的 JSON 文本，
 * 让任何 MCP 客户端（不限定厂商）都能机读。
 */

export class ToolError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  [key: string]: unknown
}

export function okResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }] }
}

export function errResult(e: unknown): ToolResult {
  const code = e instanceof ToolError ? e.code : 'internal_error'
  const message = e instanceof Error ? e.message : String(e)
  return {
    content: [
      { type: 'text', text: JSON.stringify({ ok: false, error: { code, message } }) },
    ],
    isError: true,
  }
}

/** 工具处理函数统一包装：异常 → 结构化错误结果 */
export function wrap<A extends unknown[]>(
  fn: (...args: A) => Promise<unknown>,
): (...args: A) => Promise<ToolResult> {
  return async (...args: A) => {
    try {
      return okResult(await fn(...args))
    } catch (e) {
      return errResult(e)
    }
  }
}
