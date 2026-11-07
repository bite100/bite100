import { useState, useEffect, useCallback, Component, type ReactNode } from 'react'
import { Contract } from 'ethers'
import { useConnection, useDisconnect } from 'wagmi'
import { StandardConnect } from './components/StandardConnect'
import { CHAIN_ID, VAULT_ABI, ERC20_ABI, GOVERNANCE_ADDRESS, SETTLEMENT_ADDRESS, getChainConfig } from './config'
import { GovernanceSection } from './GovernanceSection'
import { ContributionSection } from './ContributionSection'
import { Dashboard } from './components/dashboard/Dashboard'
import { OrderBookSection } from './OrderBookSection'
import { CrossChainBridge } from './components/CrossChainBridge'
import { UnifiedRewardClaim } from './components/UnifiedRewardClaim'
import { MerkleAirdropClaim } from './components/MerkleAirdropClaim'
import { AddNetworkButton } from './components/AddNetworkButton'
import { MobileConnectHint } from './components/MobileConnectHint'
import { Navigation, type Tab } from './components/Navigation'
import { TopBar } from './components/TopBar'
import { OtherPage } from './components/OtherPage'
import { DataPage } from './components/DataPage'
import { MarketsList } from './components/markets/MarketsList'
import { FlywheelRewardPlaceholder } from './components/FlywheelRewardPlaceholder'
import { isTradePair } from './config/pairs'
import { ErrorDisplay } from './components/ErrorDisplay'
import { useChain } from './hooks/useChain'
import { useOnlineStatus } from './hooks/useOnlineStatus'
import { getProvider, withSigner, formatTokenAmount, formatError, shortAddress, isValidAddress, cacheGet, cacheSet, cacheInvalidate, CACHE_KEYS, CACHE_TTL } from './utils'
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

const parseAmount = (s: string) => {
  const n = parseFloat(s)
  if (Number.isNaN(n) || n < 0) return 0n
  return BigInt(Math.floor(n * 1e18))
}

const STORAGE_KEY = 'p2p'

function setStored(key: string, value: string) {
  try {
    if (typeof window !== 'undefined') localStorage.setItem(`${STORAGE_KEY}_${key}`, value)
  } catch {}
}

/** 确保 allowance 足够：不足时按「先清零再授权 amount」的模式处理，避免某些 ERC20 的非标准行为 */
async function ensureAllowance(
  token: Contract,
  owner: string,
  spender: string,
  amount: bigint,
) {
  const current = await token.allowance(owner, spender)
  if (current >= amount) return
  if (current > 0n) {
    await (await token.approve(spender, 0n)).wait()
  }
  await (await token.approve(spender, amount)).wait()
}

async function runWithLoading(
  setLoading: (value: boolean) => void,
  setError: (msg: string | null) => void,
  fn: () => Promise<void>,
) {
  setError(null)
  setLoading(true)
  try {
    await fn()
  } catch (e) {
    setError(formatError(e))
  } finally {
    setLoading(false)
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

/** 需要钱包的分区在未连接时的页面级空态：说明 + 连接入口，不报错、不白屏 */
function ConnectGate({ title, desc, chainId }: { title: string; desc: string; chainId?: number }) {
  return (
    <div className="card connect-gate">
      <h2>{title}</h2>
      <p className="hint">{desc}</p>
      <div className="connect-gate-actions">
        <StandardConnect />
        <MobileConnectHint />
        {chainId !== undefined && <AddNetworkButton chainId={chainId} className="add-network-below-connect" />}
      </div>
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
  const [vaultBalance, setVaultBalance] = useState<string>('')
  const [vaultLocked, setVaultLocked] = useState<string>('')
  const [vaultAvailable, setVaultAvailable] = useState<string>('')
  const [walletTokenBalance, setWalletTokenBalance] = useState<string>('')
  const [tokenAddress, setTokenAddress] = useState<string>(() => {
    try {
      if (typeof window === 'undefined') return ''
      return localStorage.getItem(`${STORAGE_KEY}_tokenAddress`) ?? ''
    } catch { return '' }
  })
  const [depositAmount, setDepositAmount] = useState<string>('')
  const [withdrawAmount, setWithdrawAmount] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [loadingDeposit, setLoadingDeposit] = useState(false)
  const [loadingWithdraw, setLoadingWithdraw] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
        // 刷新余额
        if (account) {
          fetchBalances()
        }
      }
    }
  }, [currentChainId, account])

  useEffect(() => { setStored('tokenAddress', tokenAddress) }, [tokenAddress])

  const tokenAddr = tokenAddress.trim()

  /** background: 为 true 时不设置全局 loading，避免链/账户变化或刷新时误显示「连接中」 */
  const fetchBalances = useCallback(async (background = true) => {
    if (!account || !isValidAddress(tokenAddr) || !currentChainConfig) return
    const cacheKey = CACHE_KEYS.BALANCE + account + tokenAddr + currentChainConfig.chainId + ':lock1'
    const cached = cacheGet<[string, string, string, string]>(cacheKey)
    if (cached) {
      setVaultBalance(cached[0])
      setWalletTokenBalance(cached[1])
      setVaultLocked(cached[2])
      setVaultAvailable(cached[3])
      return
    }
    if (!background) {
      setError(null)
      setLoading(true)
    }
    try {
      const provider = getProvider()
      if (!provider) throw new Error('未检测到钱包')
      const vault = new Contract(currentChainConfig.contracts.vault, VAULT_ABI, provider)
      const token = new Contract(tokenAddr, ERC20_ABI, provider)
      const [vBal, wBal] = await Promise.all([
        vault.balanceOf(tokenAddr, account),
        token.balanceOf(account),
      ])
      const [lockedBal, availBal] = await Promise.all([
        vault.locked(account, tokenAddr).catch(() => 0n) as Promise<bigint>,
        vault.availableBalance(account, tokenAddr).catch(() => vBal) as Promise<bigint>,
      ])
      const vStr = formatTokenAmount(vBal)
      const wStr = formatTokenAmount(wBal)
      const lStr = formatTokenAmount(lockedBal)
      const aStr = formatTokenAmount(availBal)
      setVaultBalance(vStr)
      setWalletTokenBalance(wStr)
      setVaultLocked(lStr)
      setVaultAvailable(aStr)
      cacheSet(cacheKey, [vStr, wStr, lStr, aStr], CACHE_TTL.BALANCE)
    } catch (e) {
      setVaultBalance('')
      setWalletTokenBalance('')
      setVaultLocked('')
      setVaultAvailable('')
      if (!background) setError(formatError(e))
    } finally {
      if (!background) setLoading(false)
    }
  }, [account, tokenAddr, currentChainConfig])

  const handleDeposit = useCallback(async () => {
    if (!account || !isValidAddress(tokenAddr)) {
      setError('请先输入有效的代币地址')
      return
    }
    const amount = parseAmount(depositAmount)
    if (amount === 0n) {
      setError('请输入存入数量')
      return
    }
    await runWithLoading(setLoadingDeposit, setError, async () => {
      await withSigner(async (signer) => {
        if (!currentChainConfig) throw new Error('链配置未加载')
        const token = new Contract(tokenAddr, ERC20_ABI, signer)
        const vault = new Contract(currentChainConfig.contracts.vault, VAULT_ABI, signer)
        await ensureAllowance(token, account!, currentChainConfig.contracts.vault, amount)
        const txDeposit = await vault.deposit(tokenAddr, amount)
        await txDeposit.wait()
      })
      setDepositAmount('')
      cacheInvalidate(CACHE_KEYS.BALANCE)
      await fetchBalances()
    })
  }, [account, tokenAddr, depositAmount, fetchBalances, currentChainConfig])

  const handleWithdraw = useCallback(async () => {
    if (!account || !isValidAddress(tokenAddr)) {
      setError('请先输入有效的代币地址')
      return
    }
    const amount = parseAmount(withdrawAmount)
    if (amount === 0n) {
      setError('请输入提取数量')
      return
    }
    await runWithLoading(setLoadingWithdraw, setError, async () => {
      await withSigner(async (signer) => {
        if (!currentChainConfig) throw new Error('链配置未加载')
        const vault = new Contract(currentChainConfig.contracts.vault, VAULT_ABI, signer)
        const avail = (await vault.availableBalance(account, tokenAddr).catch(() => null)) as bigint | null
        if (avail !== null && amount > avail) {
          throw new Error(`提取数量超过可用余额：可用 ${formatTokenAmount(avail)}。挂单锁定的部分不能提取，先撤单释放后再提取。`)
        }
        const tx = await vault.withdraw(tokenAddr, amount)
        await tx.wait()
      })
      setWithdrawAmount('')
      cacheInvalidate(CACHE_KEYS.BALANCE)
      await fetchBalances()
    })
  }, [account, tokenAddr, withdrawAmount, fetchBalances, currentChainConfig])

  const handleMaxDeposit = useCallback(() => {
    if (walletTokenBalance) setDepositAmount(walletTokenBalance)
    else setError('请先查询该代币余额')
  }, [walletTokenBalance])

  const handleMaxWithdraw = useCallback(() => {
    if (vaultAvailable) setWithdrawAmount(vaultAvailable)
    else if (vaultBalance) setWithdrawAmount(vaultBalance)
    else setError('请先查询该代币余额')
  }, [vaultAvailable, vaultBalance])

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
      <ErrorDisplay
        error={error}
        onRetry={() => {
          setError(null)
          if (account && isValidAddress(tokenAddr)) fetchBalances()
        }}
        onDismiss={() => setError(null)}
        className="error-below-nav"
      />

          {activeTab === 'assets' && (
            <>
              <PageHead title="资产" desc="资金路径：钱包 → 存入 Vault → 用 Vault 余额下单结算 → 提取回钱包。下单只能使用 Vault 余额，钱包里的代币需先存入才能用于交易；本页可查询两处余额并完成存入与提取。" />
              {account && (
                <div className="card account-details-card">
                  <div className="row">
                    <span className="label">当前账户</span>
                    <span className="value mono">{shortAddress(account)}</span>
                  </div>
                  <div className="row">
                    <span className="label">连接方式</span>
                    <span className="value">{connectionLabel}</span>
                  </div>
                  <div className="row">
                    <span className="label">钱包余额（ETH）</span>
                    <span className="value">{ethBalance} ETH</span>
                  </div>
                  <button type="button" className="btn secondary" onClick={() => disconnect()} style={{ marginTop: '0.5rem' }}>
                    断开连接
                  </button>
                </div>
              )}
              {account ? (
            <div className="vault-layout">
              <div className="card vault-section">
                <h2>代币与 Vault 余额</h2>
                <p className="hint">输入 ERC20 代币合约地址查询余额，也可使用下方快捷按钮填入当前链的代币。所填地址保存在本机浏览器，刷新后仍会保留。</p>
                <div className="input-row">
                  <input
                    type="text"
                    placeholder="0x..."
                    value={tokenAddress}
                    onChange={(e) => { setTokenAddress(e.target.value); setVaultBalance(''); setWalletTokenBalance('') }}
                    className="input"
                  />
                </div>
                <div className="quick-tokens">
                  <button type="button" className="btn-quick" onClick={() => { if (currentChainConfig) { setTokenAddress(currentChainConfig.contracts.token0); setVaultBalance(''); setWalletTokenBalance(''); setVaultLocked(''); setVaultAvailable('') } }}>TKA</button>
                  <button type="button" className="btn-quick" onClick={() => { if (currentChainConfig) { setTokenAddress(currentChainConfig.contracts.token1); setVaultBalance(''); setWalletTokenBalance(''); setVaultLocked(''); setVaultAvailable('') } }}>TKB</button>
                </div>
                <button
                  className="btn secondary"
                  onClick={() => fetchBalances(false)}
                  disabled={loading || !isValidAddress(tokenAddr)}
                >
                  {loading ? '查询中…' : '查询余额'}
                </button>
                {(vaultBalance !== '' || walletTokenBalance !== '') && !error && (
                  <div className="balances">
                    <div className="row result">
                      <span className="label">钱包余额</span>
                      <span className="value">{walletTokenBalance}</span>
                    </div>
                    <div className="row result">
                      <span className="label">Vault 总额</span>
                      <span className="value">{vaultBalance}</span>
                    </div>
                    <div className="row result">
                      <span className="label">可用（可下单 / 可提取）</span>
                      <span className="value">{vaultAvailable}</span>
                    </div>
                    <div className="row result">
                      <span className="label">锁定中（挂单占用）</span>
                      <span className="value">{vaultLocked}</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="vault-actions-grid">
                <div className="card vault-section">
                  <h2>存入</h2>
                  <p className="hint">步骤：填入数量后点「存入」，在钱包中确认即可。首次存入需确认两次：代币授权与存入，之后可直接存入。注意：存入是链上交易，由你自己在钱包中确认（与下单、撤单只需签名不同）；存入完成后，Vault 余额即可用于下单。</p>
                  <div className="input-row">
                    <input
                      type="text"
                      placeholder="数量"
                      value={depositAmount}
                      onChange={(e) => setDepositAmount(e.target.value)}
                      className="input"
                    />
                    <button type="button" className="btn-max" onClick={handleMaxDeposit}>最大</button>
                  </div>
                  <button
                    className="btn primary"
                    onClick={handleDeposit}
                    disabled={loadingDeposit || !isValidAddress(tokenAddr) || !depositAmount.trim()}
                  >
                    {loadingDeposit ? '处理中…' : '存入'}
                  </button>
                </div>

                <div className="card vault-section">
                  <h2>提取</h2>
                  <p className="hint">将 Vault 余额提取回钱包：填入数量后点「提取」并在钱包中确认。只能提取「可用」部分：挂单会锁定对应余额（下单时锁定，成交时按成交量消耗，撤单或到期后释放未成交部分），锁定中的部分提不出来；想提取被锁定的部分，先到「交易」页撤掉对应挂单，释放后再提取。</p>
                  <div className="input-row">
                    <input
                      type="text"
                      placeholder="数量"
                      value={withdrawAmount}
                      onChange={(e) => setWithdrawAmount(e.target.value)}
                      className="input"
                    />
                    <button type="button" className="btn-max" onClick={handleMaxWithdraw}>最大</button>
                  </div>
                  <button
                    className="btn secondary"
                    onClick={handleWithdraw}
                    disabled={loadingWithdraw || !isValidAddress(tokenAddr) || !withdrawAmount.trim()}
                  >
                    {loadingWithdraw ? '处理中…' : '提取'}
                  </button>
                </div>
              </div>
            </div>
              ) : (
                <ConnectGate title="连接钱包后管理资产" desc="存入、提取与余额查询需要连接钱包；行情与公开数据可在「交易」「数据」分区直接浏览。" chainId={currentChainId ?? undefined} />
              )}
            </>
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
