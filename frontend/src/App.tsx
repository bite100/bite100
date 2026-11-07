import { useState, useEffect, useCallback, Component, type ReactNode } from 'react'
import { useConnection, useDisconnect } from 'wagmi'
import { CHAIN_ID, GOVERNANCE_ADDRESS, SETTLEMENT_ADDRESS, getChainConfig } from './config'
import { GovernanceSection } from './GovernanceSection'
import { ContributionSection } from './ContributionSection'
import { Dashboard } from './components/dashboard/Dashboard'
import { OrderBookSection } from './OrderBookSection'
import { CrossChainBridge } from './components/CrossChainBridge'
import { UnifiedRewardClaim } from './components/UnifiedRewardClaim'
import { MerkleAirdropClaim } from './components/MerkleAirdropClaim'
import { Navigation, type Tab } from './components/Navigation'
import { TopBar } from './components/TopBar'
import { OtherPage } from './components/OtherPage'
import { DataPage } from './components/DataPage'
import { MarketsList } from './components/markets/MarketsList'
import { AssetsPage } from './components/AssetsPage'
import { FlywheelRewardPlaceholder } from './components/FlywheelRewardPlaceholder'
import { isTradePair } from './config/pairs'
import { useChain } from './hooks/useChain'
import { useOnlineStatus } from './hooks/useOnlineStatus'
import { getProvider, formatTokenAmount } from './utils'
import './App.css'
import './components/Shell.css'

/** 治理模块错误边界：治理区报错时不影响整页 */
class GovernanceErrorBoundary extends Component<{ account: string | null; children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false }
  static getDerivedStateFromError = () => ({ hasError: true })
  componentDidCatch() {}
  render() {
    if (this.state.hasError) return (
      <div className="card vault-section">
        <h2>治理</h2>
        <p className="hint">治理模块加载异常，请刷新页面重试。</p>
      </div>
    )
    return this.props.children
  }
}

/** 统一页面骨架页头（第十三轮重构）：各一级分区共用「标题 + 一句说明」的页头规范 */
function PageHead({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="page-head">
      <h2>{title}</h2>
      {desc && <p className="hint">{desc}</p>}
    </div>
  )
}

/** 二级页返回头（第 31 轮）：桥 / 治理 / 数据内容页经「其他」进入，顶部给一条返回行 */
function SubBar({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="subbar">
      <button type="button" onClick={onBack} aria-label="返回其他页">
        ‹
      </button>
      <span className="subbar-title">{title}</span>
    </div>
  )
}

function App() {
  const connection = useConnection()
  const account = connection.address ?? null
  const { disconnect } = useDisconnect()

  const connectionLabel =
    connection.connector?.id === 'walletConnect'
      ? 'WalletConnect / 钱包应用'
      : connection.connector?.name || '浏览器钱包'

  const [ethBalance, setEthBalance] = useState<string>('')
  const isOnline = useOnlineStatus()
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    if (typeof window === 'undefined') return 'trade'
    const t = new URLSearchParams(window.location.search).get('tab')
    // 旧链接兼容（第十三轮导航重构前的页签值）：orderbook→trade、vault→assets、
    // governance/contribution→govern（并由 governSub 区分落点）
    // 第 31 轮：data 页已解散，旧 ?tab=data 落到「其他」页（数据组入口在那里），不 404
    const legacy: Record<string, Tab> = {
      orderbook: 'trade',
      vault: 'assets',
      governance: 'govern',
      contribution: 'govern',
      swap: 'trade', // 第十七轮 AMM 兑换下线：旧「兑换」链接落到交易分区
      data: 'other',
    }
    if (t && legacy[t]) return legacy[t]
    const valid: Tab[] = ['trade', 'markets', 'assets', 'other', 'bridge', 'govern', 'data']
    return valid.includes(t as Tab) ? (t as Tab) : 'trade'
  })
  const [governSub, setGovernSub] = useState<'governance' | 'contribution'>(() => {
    if (typeof window === 'undefined') return 'governance'
    const t = new URLSearchParams(window.location.search).get('tab')
    return t === 'contribution' ? 'contribution' : 'governance'
  })
  const [showFullOrderbook, setShowFullOrderbook] = useState(false)
  /** 数据内容页的目标锚点（从「其他」页数据组进入时定位到对应区块） */
  const [dataAnchor, setDataAnchor] = useState<string | null>(null)

  /** 从行情页/选对页跳交易页：与 useCurrentPair 同一口径，先改写 ?pair= 再切页 */
  const goTradeWithPair = useCallback((pair: string) => {
    if (isTradePair(pair)) {
      const url = new URL(window.location.href)
      url.searchParams.set('pair', pair)
      window.history.replaceState(null, '', url.toString())
    }
    setActiveTab('trade')
  }, [])

  const openData = useCallback((anchor: string) => {
    setDataAnchor(anchor)
    setActiveTab('data')
  }, [])

  // 链切换
  const { currentChainId, switchChain } = useChain()
  const [currentChainConfig, setCurrentChainConfig] = useState(() => getChainConfig(CHAIN_ID))
  
  // 当链切换时，更新配置
  useEffect(() => {
    if (currentChainId) {
      const config = getChainConfig(currentChainId)
      if (config) {
        setCurrentChainConfig(config)
      }
    }
  }, [currentChainId, account])


  useEffect(() => {
    if (!account) return
    const provider = getProvider()
    if (!provider) return
    provider.getBalance(account).then((b) => setEthBalance(formatTokenAmount(b)))
  }, [account])

  /** 交易屏与完整订单簿共用的 signer 获取（未连接/无注入钱包时返回 null，由调用方走空态） */
  const getSigner = useCallback(async () => {
    try {
      const p = getProvider()
      if (!p) return null
      return await p.getSigner()
    } catch {
      return null
    }
  }, [])

  return (
    <div className="app">
      {!isOnline && (
        <div className="offline-banner" role="status">
          当前处于离线状态，请检查网络连接
        </div>
      )}
      <TopBar
        title={
          activeTab === 'trade'
            ? '比特100'
            : activeTab === 'markets'
              ? '行情'
              : activeTab === 'assets'
                ? '资产'
                : activeTab === 'other'
                  ? '其他'
                  : activeTab === 'bridge'
                    ? '跨链桥'
                    : activeTab === 'govern'
                      ? '治理与贡献'
                      : '数据'
        }
        chainId={currentChainId}
        onChainChange={switchChain}
        account={account}
        onWalletClick={() => setActiveTab('assets')}
      />

      <Navigation activeTab={activeTab} onTabChange={setActiveTab} />

          {activeTab === 'assets' && (
            <AssetsPage
              account={account}
              chainConfig={currentChainConfig}
              chainId={currentChainId}
              connectionLabel={connectionLabel}
              ethBalance={ethBalance}
              onDisconnect={() => disconnect()}
              goTrade={goTradeWithPair}
            />
          )}

          {activeTab === 'markets' && (
            <>
              <PageHead title="行情" desc="本站全部交易对的最新成交价与 24 小时涨跌；点任意一行进入该交易对的交易页。" />
              <section className="card markets-card">
                <MarketsList
                  chainId={currentChainId ?? CHAIN_ID}
                  account={account}
                  mode="page"
                  onSelectPair={goTradeWithPair}
                />
              </section>
            </>
          )}

          {activeTab === 'other' && (
            <OtherPage
              onOpenBridge={() => setActiveTab('bridge')}
              onOpenGovern={() => setActiveTab('govern')}
              onOpenData={openData}
            />
          )}

          {activeTab === 'data' && (
            <>
              <SubBar title="数据" onBack={() => setActiveTab('other')} />
              <DataPage
                anchor={dataAnchor}
                chainName={currentChainConfig?.name || '未知网络'}
                vaultAddress={currentChainConfig?.contracts.vault ?? ''}
                settlementAddress={SETTLEMENT_ADDRESS}
                governanceAddress={GOVERNANCE_ADDRESS}
              />
            </>
          )}

          {activeTab === 'trade' && (showFullOrderbook ? (
            <OrderBookSection
              account={account}
              getSigner={getSigner}
              onBackToDashboard={() => setShowFullOrderbook(false)}
            />
          ) : (
            <Dashboard
              account={account}
              getSigner={getSigner}
              onShowFullOrderbook={() => setShowFullOrderbook(true)}
            />
          ))}

          {activeTab === 'govern' && (
            <>
              <SubBar title="治理与贡献" onBack={() => setActiveTab('other')} />
              <PageHead title="治理与贡献" desc="参与协议治理投票，或查询并领取你的贡献奖励。投票期 7 天、通过后有 2 天时锁才执行，规则写在治理合约里。" />
              <div className="text-tabs govern-tabs" role="tablist" aria-label="治理与贡献分区">
                <button
                  type="button"
                  role="tab"
                  aria-selected={governSub === 'governance'}
                  className={governSub === 'governance' ? 'on' : undefined}
                  onClick={() => setGovernSub('governance')}
                >
                  治理
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={governSub === 'contribution'}
                  className={governSub === 'contribution' ? 'on' : undefined}
                  onClick={() => setGovernSub('contribution')}
                >
                  贡献奖励
                </button>
              </div>
              {governSub === 'governance' ? (
                <GovernanceErrorBoundary account={account}>
                  <GovernanceSection account={account} />
                </GovernanceErrorBoundary>
              ) : (
                <>
                  <ContributionSection account={account} />
                  <UnifiedRewardClaim account={account} />
                  <MerkleAirdropClaim account={account} />
                  <FlywheelRewardPlaceholder />
                </>
              )}
            </>
          )}

          {activeTab === 'bridge' && (
            <>
              <SubBar title="跨链桥" onBack={() => setActiveTab('other')} />
              <PageHead title="跨链桥" desc="通过 LayerZero 在链之间转移代币，资产到达目标链后可继续交易；发起转移需要连接钱包。" />
              <CrossChainBridge account={account} currentChainId={currentChainId} />
            </>
          )}

    </div>
  )
}

export default App
