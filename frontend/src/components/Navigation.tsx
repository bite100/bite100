/**
 * 第 31 轮主导航：一级页 = 交易 / 行情 / 资产 / 其他（桥、治理、数据内容页为二级页，
 * 底部栏高亮归属「其他」）。移动端为底部固定标签栏（56px + 安全区），
 * 桌面 ≥1024px 变为顶栏下方的横排导航。同一个组件换定位，不改栏目与顺序。
 */
import './Navigation.css'

export type Tab =
  | 'trade'
  | 'markets'
  | 'assets'
  | 'other'
  | 'bridge'
  | 'govern'
  | 'data'
  | 'ai'

export const PRIMARY_TABS: { key: Tab; label: string }[] = [
  { key: 'trade', label: '交易' },
  { key: 'markets', label: '行情' },
  { key: 'assets', label: '资产' },
  { key: 'other', label: '其他' },
]

/** 二级页在底部栏的归属：桥 / 治理 / 数据内容页 / AI 接入说明页都归「其他」 */
export function bottomTabOf(tab: Tab): Tab {
  if (tab === 'bridge' || tab === 'govern' || tab === 'data' || tab === 'ai') return 'other'
  return tab
}

function TabIcon({ tab }: { tab: Tab }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  switch (tab) {
    case 'trade':
      return (
        <svg {...common}>
          <path d="M4 17V9M9.3 17V5M14.6 17v-6M20 17V7" />
          <path d="M3 20h18" />
        </svg>
      )
    case 'markets':
      return (
        <svg {...common}>
          <path d="M4 19V11M9 19V5M14 19v-8M19 19V8" />
        </svg>
      )
    case 'assets':
      return (
        <svg {...common}>
          <rect x="3" y="6" width="18" height="13" rx="3" />
          <path d="M3 10h18M16 15h2" />
        </svg>
      )
    default:
      return (
        <svg {...common}>
          <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
        </svg>
      )
  }
}

interface NavigationProps {
  activeTab: Tab
  onTabChange: (tab: Tab) => void
}

export function Navigation({ activeTab, onTabChange }: NavigationProps) {
  const active = bottomTabOf(activeTab)
  return (
    <nav className="tabbar" aria-label="主导航">
      {PRIMARY_TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          className={active === t.key ? 'tabbar-item active' : 'tabbar-item'}
          aria-current={active === t.key ? 'page' : undefined}
          onClick={() => onTabChange(t.key)}
        >
          <TabIcon tab={t.key} />
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  )
}
