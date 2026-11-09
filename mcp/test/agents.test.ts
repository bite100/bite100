import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentRegistry, WriteGuard, hashToken } from '../src/agents'
import { FIXTURE_REGISTRY } from './helpers'

describe('AgentRegistry', () => {
  it('令牌哈希认证：对的令牌找到 agent，错的拒绝', () => {
    const reg = AgentRegistry.load(FIXTURE_REGISTRY)
    expect(reg.authenticate('test-token-maker').id).toBe('maker-test')
    expect(() => reg.authenticate('wrong-token')).toThrowError(/令牌无效/)
  })

  it('hashToken 是 SHA-256 十六进制', () => {
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('WriteGuard 护栏', () => {
  afterEach(() => {
    delete process.env.BIT100_MCP_KILL_SWITCH
  })

  it('停用 agent → agent_disabled', () => {
    const reg = AgentRegistry.load(FIXTURE_REGISTRY)
    const guard = new WriteGuard(reg)
    const disabled = reg.byId('disabled-test')!
    expect(() => guard.check(disabled, 1)).toThrowError(
      expect.objectContaining({ code: 'agent_disabled' }),
    )
  })

  it('超单笔上限 → over_per_order_cap', () => {
    const reg = AgentRegistry.load(FIXTURE_REGISTRY)
    const guard = new WriteGuard(reg)
    const capped = reg.byId('capped-test')! // 单笔上限 2
    expect(() => guard.check(capped, 2.5)).toThrowError(
      expect.objectContaining({ code: 'over_per_order_cap' }),
    )
    expect(() => guard.check(capped, 2)).not.toThrow()
  })

  it('每日上限累计 → over_daily_cap', () => {
    const reg = AgentRegistry.load(FIXTURE_REGISTRY)
    const guard = new WriteGuard(reg)
    const capped = reg.byId('capped-test')! // 每日上限 5，单笔 2
    guard.check(capped, 2)
    guard.record(capped, 2)
    guard.check(capped, 2)
    guard.record(capped, 2)
    expect(() => guard.check(capped, 2)).toThrowError(
      expect.objectContaining({ code: 'over_daily_cap' }),
    )
  })

  it('频率上限 → rate_limited', () => {
    const reg = AgentRegistry.load(FIXTURE_REGISTRY)
    const guard = new WriteGuard(reg)
    const maker = reg.byId('maker-test')! // 3 次/分钟
    for (let i = 0; i < 3; i++) {
      guard.check(maker, 0.1)
      guard.record(maker, 0.1)
    }
    expect(() => guard.check(maker, 0.1)).toThrowError(
      expect.objectContaining({ code: 'rate_limited' }),
    )
  })

  it('全局急停（环境变量）→ kill_switch_on', () => {
    process.env.BIT100_MCP_KILL_SWITCH = '1'
    const reg = AgentRegistry.load(FIXTURE_REGISTRY)
    const guard = new WriteGuard(reg)
    const maker = reg.byId('maker-test')!
    expect(reg.killSwitchOn()).toBe(true)
    expect(() => guard.check(maker, 0.1)).toThrowError(
      expect.objectContaining({ code: 'kill_switch_on' }),
    )
  })

  it('全局急停（kill-switch 文件）同样生效', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-reg-'))
    const cfg = join(dir, 'agents.json')
    copyFileSync(FIXTURE_REGISTRY, cfg)
    writeFileSync(join(dir, 'kill-switch'), 'on')
    const reg = AgentRegistry.load(cfg)
    expect(reg.killSwitchOn()).toBe(true)
  })
})
