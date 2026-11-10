/**
 * 第 59 轮块 3：AI 接入页改自助接入后的文案钉子——
 * 自助口径（一段话、注册、skill.md、真实入口地址、限额与爬坡、
 * operator 不开放）在场；申请制旧口径（向项目方申请、占位地址、
 * 逐个发放）不得回潮。
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AiAccessPage } from './AiAccessPage'

const html = (): string => renderToStaticMarkup(<AiAccessPage />)

describe('AiAccessPage（第 59 轮自助接入）', () => {
  it('状态徽标与入口事实：自助接入 + 真实公开地址 + 说明书地址', () => {
    const text = html()
    expect(text).toContain('AI 自助接入（无需申请）')
    expect(text).toContain('https://bit100-mcp.q3874758.workers.dev')
    expect(text).toContain('https://bit100-mcp.q3874758.workers.dev/skill.md')
  })

  it('一段话接入在场（含注册与令牌安全指令）', () => {
    const text = html()
    expect(text).toContain('把这段话发给你的 AI')
    expect(text).toContain('POST /register')
    expect(text).toContain('never send the token to any other domain')
    expect(text).toContain('复制这段话')
  })

  it('限额与爬坡、记账口径如实写明', () => {
    const text = html()
    expect(text).toContain('单笔最多 10')
    expect(text).toContain('每天累计最多 50')
    expect(text).toContain('头 24 小时爬坡')
    expect(text).toContain('被中继接受的那一刻就计入每日额度')
  })

  it('角色隔离：operator 不开放自助注册', () => {
    const text = html()
    expect(text).toContain('operator')
    expect(text).toContain('不开放自助注册')
  })

  it('申请制旧口径不得出现', () => {
    const text = html()
    expect(text).not.toContain('申请制')
    expect(text).not.toContain('向项目方申请')
    expect(text).not.toContain('<项目方提供的接入地址>')
    expect(text).not.toContain('没有公开的自助注册入口')
    expect(text).not.toContain('逐个发放')
  })

  it('注意事项：令牌一次性 + 未落锁撤单缺口 + 钱包身份预留', () => {
    const text = html()
    expect(text).toContain('只显示一次')
    expect(text).toContain('未落锁的挂单撤不了')
    expect(text).toContain('SIWE / ERC-8004')
  })

  it('8 工具齐全（match_order 已在公开入口）', () => {
    const text = html()
    for (const name of [
      'get_chain_config',
      'get_orderbook',
      'list_orders',
      'get_balances',
      'get_order_status',
      'place_order',
      'match_order',
      'hard_cancel_order',
    ]) {
      expect(text).toContain(name)
    }
  })
})
