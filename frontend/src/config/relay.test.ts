/**
 * 第 51 轮改写：原测试钉的是第 34/35 轮的双读三态模式
 * （parseRelayMode / effectiveRelayMode / RELAY_ACTIVE_WIRED /
 * RELAY_MODE*）——三态模式随节点退役一并删除（中继即主通道，无模式
 * 可言），原断言已无对应物。新断言改为单源配置的事实：RELAY_URL
 * 规范化（去尾斜杠）与 RELAY_CONFIGURED 与 URL 空非空严格一致。
 * 改写登记见 docs/round51-stage5-node-retirement-2026-11-09.md。
 */
import { describe, it, expect } from 'vitest'
import { RELAY_URL, RELAY_CONFIGURED } from './relay'

describe('中继单源配置（第 51 轮）', () => {
  it('RELAY_CONFIGURED 与 RELAY_URL 是否为空严格一致', () => {
    expect(RELAY_CONFIGURED).toBe(RELAY_URL !== '')
  })

  it('RELAY_URL 已规范化：无尾斜杠、无首尾空白', () => {
    expect(RELAY_URL).toBe(RELAY_URL.trim())
    expect(RELAY_URL.endsWith('/')).toBe(false)
  })
})
