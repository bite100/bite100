import './Navigation.css'

export type Tab = 'trade' | 'swap' | 'assets' | 'bridge' | 'govern' | 'data'

interface NavigationProps {
  activeTab: Tab
  onTabChange: (tab: Tab) => void
}

const TABS: { key: Tab; label: string }[] = [
  { key: 'trade', label: '交易' },
  { key: 'swap', label: '兑换' },
  { key: 'assets', label: '资产' },
  { key: 'bridge', label: '跨链桥' },
  { key: 'govern', label: '治理与贡献' },
  { key: 'data', label: '数据' },
]

/**
 * 全站主导航（第十三轮信息架构重构）：六个一级分区。
 * 未连接钱包时同样可见——交易行情与公开数据可直接浏览（对标 Hyperliquid 公开行情模式），
 * 需要钱包的分区在页内给出连接空态，而不是把整站挡在连接之后。
 */
export function Navigation({ activeTab, onTabChange }: NavigationProps) {
  return (
    <nav className="main-nav" aria-label="主导航">
      {TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          className={`nav-tab ${activeTab === t.key ? 'active' : ''}`}
          onClick={() => onTabChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  )
}
