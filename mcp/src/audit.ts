/**
 * 审计日志：append-only JSONL，按 agent 分文件（audit/<agentId>.jsonl），
 * 只追加不改写。每条 = 一次工具调用：时间、agent、工具、参数摘要、
 * 结果摘要、tx 哈希（如有）。参数摘要由各工具显式构造，禁止把令牌或
 * 私钥类字段写进来（工具参数本身也不接受这类字段）。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface AuditEntry {
  ts: string
  agentId: string
  tool: string
  params: Record<string, unknown>
  result: string
  txHash?: string
  errorCode?: string
}

export class AuditLog {
  private dir: string

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(dir, { recursive: true })
  }

  append(entry: AuditEntry): void {
    const file = join(this.dir, `${entry.agentId.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`)
    appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8')
  }
}

/** 无审计的空实现（只读独立运行/单测用） */
export const nullAudit: Pick<AuditLog, 'append'> = { append: () => {} }
