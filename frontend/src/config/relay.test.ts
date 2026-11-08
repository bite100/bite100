/**
 * 第 35 轮 D8：双读模式解析与「未接线」降级测试。
 * active 在阶段 3 接线前不得成为有效模式：请求 active → 有效 shadow，
 * 且 RELAY_MODE（全站生效值）在未接线时不许为 active。
 */
import { describe, it, expect } from 'vitest'
import {
  RELAY_ACTIVE_WIRED,
  RELAY_MODE,
  RELAY_MODE_REQUESTED,
  effectiveRelayMode,
  parseRelayMode,
} from './relay'

const URL = 'https://relay.example'

describe('parseRelayMode（请求模式解析，口径不变）', () => {
  it('shadow/active 原样解析，大小写与空白不敏感', () => {
    expect(parseRelayMode('shadow', URL)).toBe('shadow')
    expect(parseRelayMode(' Active ', URL)).toBe('active')
  })

  it('未知值/空值 → disabled；无中继 URL → 恒 disabled', () => {
    expect(parseRelayMode('bogus', URL)).toBe('disabled')
    expect(parseRelayMode(undefined, URL)).toBe('disabled')
    expect(parseRelayMode('active', '')).toBe('disabled')
  })
})

describe('effectiveRelayMode（第 35 轮 D8 门禁）', () => {
  it('active 未接线时降为 shadow；接线后才放行', () => {
    expect(RELAY_ACTIVE_WIRED).toBe(false) // 阶段 3 接线时同步改 true 并更新本断言
    expect(effectiveRelayMode('active')).toBe('shadow')
    expect(effectiveRelayMode('shadow')).toBe('shadow')
    expect(effectiveRelayMode('disabled')).toBe('disabled')
  })

  it('全站生效模式与请求模式自洽：请求 active 时生效必为 shadow', () => {
    if (RELAY_MODE_REQUESTED === 'active') {
      expect(RELAY_MODE).toBe('shadow')
    } else {
      expect(RELAY_MODE).toBe(RELAY_MODE_REQUESTED)
    }
  })
})
