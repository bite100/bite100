import './Navigation.css'

export type Tab = 'vault' | 'orderbook' | 'swap' | 'data' | 'bridge' | 'governance' | 'contribution'

interface NavigationProps {
  activeTab: Tab
  onTabChange: (tab: Tab) => void
  account: string | null
}

export function Navigation({ activeTab, onTabChange, account }: NavigationProps) {
  if (!account) return null

  return (
    <nav className="main-nav">
      <button
        className={`nav-tab ${activeTab === 'orderbook' ? 'active' : ''}`}
        onClick={() => onTabChange('orderbook')}
      >
        买卖
      </button>
      <button
        className={`nav-tab ${activeTab === 'vault' ? 'active' : ''}`}
        onClick={() => onTabChange('vault')}
      >
        存提
      </button>
      <button
        className={`nav-tab ${activeTab === 'swap' ? 'active' : ''}`}
        onClick={() => onTabChange('swap')}
      >
        Swap
      </button>
      <button
        className={`nav-tab ${activeTab === 'data' ? 'active' : ''}`}
        onClick={() => onTabChange('data')}
      >
        数据
      </button>
      <button
        className={`nav-tab ${activeTab === 'bridge' ? 'active' : ''}`}
        onClick={() => onTabChange('bridge')}
      >
        跨链桥
      </button>
      <button
        className={`nav-tab ${activeTab === 'governance' ? 'active' : ''}`}
        onClick={() => onTabChange('governance')}
      >
        治理
      </button>
      <button
        className={`nav-tab ${activeTab === 'contribution' ? 'active' : ''}`}
        onClick={() => onTabChange('contribution')}
      >
        贡献
      </button>
    </nav>
  )
}
