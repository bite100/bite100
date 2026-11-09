/**
 * 「其他」页（第 31 轮）：分组菜单页，只做入口——
 * 功能组（跨链桥 / 治理与贡献 / AI 接入三个二级页）、数据组（数据内容页的四个锚点）、关于组。
 * 不编造不存在的入口（没有客服、没有设置项）。
 */
import { useState } from 'react'
import { CHANNEL_DISCLOSURES } from '../services/defaultBridge/disclosures'
import { loadSettings } from '../services/defaultBridge/settings'
import './OtherPage.css'

interface OtherPageProps {
  onOpenBridge: () => void
  onOpenGovern: () => void
  onOpenAi: () => void
  onOpenData: (anchor: string) => void
  /** 第四十一轮：跨链交付设置入口行要读当前用户的设置摘要 */
  account?: string | null
}

function Icon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  )
}

export function OtherPage({ onOpenBridge, onOpenGovern, onOpenAi, onOpenData, account }: OtherPageProps) {
  const [aboutOpen, setAboutOpen] = useState(false)
  // 第四十一轮：跨链交付设置入口行（设计 §2.2）——摘要读本机保存的设置，未连接/未设置时给通用文案
  const deliverySummary = (() => {
    if (!account) return '预先选好默认通道，跨链成交后自动把成交款送回你的主场链'
    const s = loadSettings(account)
    if (!s.defaultChannel) return '未设置：跨链成交款先留成交链 Vault，可点此去桥页设置'
    const name = CHANNEL_DISCLOSURES[s.defaultChannel].name
    return s.standingAuth
      ? `默认通道 ${name}，自动交付已开启`
      : `默认通道 ${name}，自动交付已关闭`
  })()
  return (
    <div className="other-page">
      <p className="other-intro">
        跨链桥、治理与贡献、AI 接入，以及原「数据」页的公开数据都收在这里，从下面进入。
      </p>

      <h3 className="menu-group-title">功能</h3>
      <section className="card other-card">
        <button type="button" className="menu-row" onClick={onOpenBridge}>
          <span className="menu-ico">
            <Icon d="M7 8h11l-3-3M17 16H6l3 3" />
          </span>
          <span className="menu-txt">
            <b>跨链桥</b>
            <span>在 Sepolia 与 Base Sepolia 之间转移代币，四条通道自己选</span>
          </span>
          <span className="menu-arrow">›</span>
        </button>
        <button type="button" className="menu-row" onClick={onOpenBridge}>
          <span className="menu-ico">
            <Icon d="M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5" />
          </span>
          <span className="menu-txt">
            <b>跨链交付设置</b>
            <span>跨链交付设置：{deliverySummary} ›</span>
          </span>
          <span className="menu-arrow">›</span>
        </button>
        <button type="button" className="menu-row" onClick={onOpenGovern}>
          <span className="menu-ico">
            <Icon d="M12 3v3M5 21h14M7 21c0-4 2-6 5-6s5 2 5 6" />
          </span>
          <span className="menu-txt">
            <b>治理与贡献</b>
            <span>提案投票（7 天表决 + 2 天时锁）与贡献奖励领取</span>
          </span>
          <span className="menu-arrow">›</span>
        </button>
        <button type="button" className="menu-row" onClick={onOpenAi}>
          <span className="menu-ico">
            <Icon d="M7 7h10v10H7zM4 10h3M4 14h3M17 10h3M17 14h3M10 4v3M14 4v3M10 17v3M14 17v3" />
          </span>
          <span className="menu-txt">
            <b>AI 接入</b>
            <span>把你自己的 AI 接到交易所：读盘口、下单、交易（测试网申请制）</span>
          </span>
          <span className="menu-arrow">›</span>
        </button>
      </section>

      <h3 className="menu-group-title">数据</h3>
      <section className="card other-card">
        <button type="button" className="menu-row" onClick={() => onOpenData('data-rewards')}>
          <span className="menu-ico">
            <Icon d="M12 3v18M7 7.5c0-1.4 2.2-2.5 5-2.5s5 1.1 5 2.5-2.2 2.5-5 2.5-5-1.1-5-2.5ZM7 16.5c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5" />
          </span>
          <span className="menu-txt">
            <b>奖励与权重</b>
            <span>贡献奖励池余额与现行权重构成</span>
          </span>
          <span className="menu-arrow">›</span>
        </button>
        <button type="button" className="menu-row" onClick={() => onOpenData('data-periods')}>
          <span className="menu-ico">
            <Icon d="M5 5h14M5 12h14M5 19h9" />
          </span>
          <span className="menu-txt">
            <b>期次记录</b>
            <span>最近奖励期次与领取截止时间</span>
          </span>
          <span className="menu-arrow">›</span>
        </button>
        <button type="button" className="menu-row" onClick={() => onOpenData('data-contracts')}>
          <span className="menu-ico">
            <Icon d="M8 3h8l4 4v14H8zM16 3v4h4" />
          </span>
          <span className="menu-txt">
            <b>合约地址</b>
            <span>金库、结算与治理合约地址（链上可查）</span>
          </span>
          <span className="menu-arrow">›</span>
        </button>
        <button type="button" className="menu-row" onClick={() => onOpenData('data-relay')}>
          <span className="menu-ico">
            <Icon d="M4 12a8 8 0 0 1 14-5M20 12a8 8 0 0 1-14 5M18 3v4h-4M6 21v-4h4" />
          </span>
          <span className="menu-txt">
            <b>中继状态</b>
            <span>无节点中继（主中继 / Nostr 镜像 / 链上索引）的部署与健康</span>
          </span>
          <span className="menu-arrow">›</span>
        </button>
      </section>

      <h3 className="menu-group-title">关于</h3>
      <section className="card other-card">
        <button
          type="button"
          className="menu-row"
          aria-expanded={aboutOpen}
          onClick={() => setAboutOpen((v) => !v)}
        >
          <span className="menu-ico">
            <Icon d="M12 8h.01M12 11v5M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z" />
          </span>
          <span className="menu-txt">
            <b>关于本站</b>
            <span>比特100 是什么、订单与资金怎么走</span>
          </span>
          <span className="menu-arrow">{aboutOpen ? '⌄' : '›'}</span>
        </button>
        {aboutOpen && (
          <div className="other-about">
            <p>
              比特100 是链无关的 P2P
              去中心化交易所：打开网站、连接钱包即可交易，资产在哪条链上就在哪条链上成交。下单只需签名、不发链上交易；gas
              由中继代付，结算时从成交额里买卖双方对半分摊，你不需要自备原生代币。交易手续费 0.01%。
            </p>
            <p>
              资金路径：钱包 → 存入 Vault → 用 Vault 余额下单结算 → 提取回钱包。页面上的说明文字都写在各功能区里（资产页的存入/提取说明、交易页的下单说明、桥页的通道风险），操作前请先看完对应说明再确认。
            </p>
          </div>
        )}
      </section>
    </div>
  )
}
