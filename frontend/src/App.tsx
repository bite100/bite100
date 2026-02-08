import { useState, useEffect, useCallback, Component, type ReactNode } from 'react'
import { Contract } from 'ethers'
import { CHAIN_ID, RPC_URL, VAULT_ADDRESS, VAULT_ABI, ERC20_ABI, AMM_ABI, TOKEN0_ADDRESS, TOKEN1_ADDRESS, AMM_POOL_ADDRESS, GOVERNANCE_ADDRESS, SETTLEMENT_ADDRESS, getChainConfig } from './config'
import { GovernanceSection } from './GovernanceSection'
import { ContributionSection } from './ContributionSection'
import { OrderBookSection } from './OrderBookSection'
import { CrossChainBridge } from './components/CrossChainBridge'
import { Navigation, type Tab } from './components/Navigation'
import { LoadingSpinner } from './components/LoadingSpinner'
import { ErrorDisplay } from './components/ErrorDisplay'
import { ChainSwitcher } from './components/ChainSwitcher'
import { useChain } from './hooks/useChain'
import { getEthereum, getProvider, withSigner, formatTokenAmount, formatError, shortAddress, isValidAddress, isElectron, cacheGet, cacheSet, cacheInvalidate, CACHE_KEYS, CACHE_TTL } from './utils'
import './App.css'

/** 治理模块错误边界：治理区报错时不影响整页 */
class GovernanceErrorBoundary extends Component<{ account: string | null; children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false }
  static getDerivedStateFromError = () => ({ hasError: true })
  componentDidCatch() {}
  render() {
    if (this.state.hasError) return (
      <div className="card vault-section">
        <h2>治理</h2>
        <p className="hint">治理模块加载异常，请刷新页面。若持续报错，请检查 config.ts 中 GOVERNANCE_ADDRESS 是否正确。</p>
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

function App() {
  const [account, setAccount] = useState<string | null>(null)
  const [ethBalance, setEthBalance] = useState<string>('')
  const [vaultBalance, setVaultBalance] = useState<string>('')
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
  const [loadingSwap, setLoadingSwap] = useState(false)
  const [loadingAddLiq, setLoadingAddLiq] = useState(false)
  const [swapTokenIn, setSwapTokenIn] = useState<'token0' | 'token1'>(() => {
    try {
      if (typeof window === 'undefined') return 'token0'
      const r = localStorage.getItem(`${STORAGE_KEY}_swapTokenIn`)
      return r === 'token1' ? 'token1' : 'token0'
    } catch { return 'token0' }
  })
  const [swapAmount, setSwapAmount] = useState<string>('')
  const [swapAmountOut, setSwapAmountOut] = useState<string>('')
  const [addLiqAmount0, setAddLiqAmount0] = useState<string>('')
  const [addLiqAmount1, setAddLiqAmount1] = useState<string>('')
  const [reserve0, setReserve0] = useState<string>('')
  const [reserve1, setReserve1] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [isOnline, setIsOnline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine)
  const [activeTab, setActiveTab] = useState<Tab>('vault')
  
  // 链切换
  const { currentChainId, switchChain } = useChain()
  const [currentChainConfig, setCurrentChainConfig] = useState(() => getChainConfig(CHAIN_ID))
  
  // 当链切换时，更新配置
  useEffect(() => {
    if (currentChainId) {
      const config = getChainConfig(currentChainId)
      if (config) {
        setCurrentChainConfig(config)
        // 刷新余额和储备
        if (account) {
          fetchBalances()
          fetchReserves()
        }
      }
    }
  }, [currentChainId, account])

  useEffect(() => { setStored('tokenAddress', tokenAddress) }, [tokenAddress])
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onOnline = () => setIsOnline(true)
    const onOffline = () => setIsOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])
  useEffect(() => { setStored('swapTokenIn', swapTokenIn) }, [swapTokenIn])

  const connectWallet = useCallback(async () => {
    setError(null)
    try {
      const ethereum = getEthereum()
      if (!ethereum) {
        setError(isElectron()
          ? '桌面版需先在 Chrome 或 Edge 中安装 MetaMask。若已安装仍无法连接，请使用浏览器打开 https://p2p-p2p.github.io/p2p/'
          : '请安装 MetaMask 或其他钱包扩展')
        return
      }
      const provider = getProvider()
      if (!provider) {
        setError(isElectron()
          ? '桌面版需先在 Chrome 或 Edge 中安装 MetaMask。若已安装仍无法连接，请使用浏览器打开 https://p2p-p2p.github.io/p2p/'
          : '请安装 MetaMask 或其他钱包扩展')
        return
      }
      const accounts = (await ethereum.request({ method: 'eth_requestAccounts' })) as string[]
      if (!accounts.length) {
        setError('未获取到账户')
        return
      }
      // 检查当前链，如果不支持则提示切换
      const chainIdRaw = await ethereum.request({ method: 'eth_chainId' })
      const chainId = typeof chainIdRaw === 'string' ? parseInt(chainIdRaw, 16) : Number(chainIdRaw)
      const currentConfig = getChainConfig(chainId)
      
      if (!currentConfig) {
        // 当前链不支持，提示用户切换
        setError(`当前链（Chain ID: ${chainId}）不支持，请切换到支持的链`)
        // 不阻止连接，但提示用户切换
      }
      setAccount(accounts[0])
      const balance = await provider.getBalance(accounts[0])
      setEthBalance(balance ? (Number(balance) / 1e18).toFixed(6) : '0')
    } catch (e) {
      setError(formatError(e))
    }
  }, [])

  const tokenAddr = tokenAddress.trim()

  const fetchBalances = useCallback(async () => {
    if (!account || !isValidAddress(tokenAddr) || !currentChainConfig) return
    const cacheKey = CACHE_KEYS.BALANCE + account + tokenAddr + currentChainConfig.chainId
    const cached = cacheGet<[string, string]>(cacheKey)
    if (cached) {
      setVaultBalance(cached[0])
      setWalletTokenBalance(cached[1])
      return
    }
    setError(null)
    setLoading(true)
    try {
      const provider = getProvider()
      if (!provider) throw new Error('未检测到钱包')
      const vault = new Contract(currentChainConfig.contracts.vault, VAULT_ABI, provider)
      const token = new Contract(tokenAddr, ERC20_ABI, provider)
      const [vBal, wBal] = await Promise.all([
        vault.balanceOf(tokenAddr, account),
        token.balanceOf(account),
      ])
      const vStr = formatTokenAmount(vBal)
      const wStr = formatTokenAmount(wBal)
      setVaultBalance(vStr)
      setWalletTokenBalance(wStr)
      cacheSet(cacheKey, [vStr, wStr], CACHE_TTL.BALANCE)
    } catch (e) {
      setVaultBalance('')
      setWalletTokenBalance('')
      setError(formatError(e))
    } finally {
      setLoading(false)
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
    setError(null)
    setLoadingDeposit(true)
    try {
      await withSigner(async (signer) => {
        if (!currentChainConfig) throw new Error('链配置未加载')
        const token = new Contract(tokenAddr, ERC20_ABI, signer)
        const vault = new Contract(currentChainConfig.contracts.vault, VAULT_ABI, signer)
        const txApprove = await token.approve(currentChainConfig.contracts.vault, amount)
        await txApprove.wait()
        const txDeposit = await vault.deposit(tokenAddr, amount)
        await txDeposit.wait()
      })
      setDepositAmount('')
      cacheInvalidate(CACHE_KEYS.BALANCE)
      await fetchBalances()
    } catch (e) {
      setError(formatError(e))
    } finally {
      setLoadingDeposit(false)
    }
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
    setError(null)
    setLoadingWithdraw(true)
    try {
      await withSigner(async (signer) => {
        if (!currentChainConfig) throw new Error('链配置未加载')
        const vault = new Contract(currentChainConfig.contracts.vault, VAULT_ABI, signer)
        const tx = await vault.withdraw(tokenAddr, amount)
        await tx.wait()
      })
      setWithdrawAmount('')
      cacheInvalidate(CACHE_KEYS.BALANCE)
      await fetchBalances()
    } catch (e) {
      setError(formatError(e))
    } finally {
      setLoadingWithdraw(false)
    }
  }, [account, tokenAddr, withdrawAmount, fetchBalances, currentChainConfig])

  const fetchReserves = useCallback(async () => {
    if (!currentChainConfig || currentChainConfig.contracts.ammPool === '0x0000000000000000000000000000000000000000') {
      setReserve0('0')
      setReserve1('0')
      return
    }
    const cached = cacheGet<[string, string]>(CACHE_KEYS.RESERVES)
    if (cached) {
      setReserve0(cached[0])
      setReserve1(cached[1])
      return
    }
    try {
      const provider = getProvider()
      if (!provider) return
      const amm = new Contract(currentChainConfig.contracts.ammPool, AMM_ABI, provider)
      const [r0, r1] = await Promise.all([amm.reserve0(), amm.reserve1()])
      const r0Str = formatTokenAmount(r0)
      const r1Str = formatTokenAmount(r1)
      setReserve0(r0Str)
      setReserve1(r1Str)
      cacheSet(CACHE_KEYS.RESERVES, [r0Str, r1Str], CACHE_TTL.RESERVES)
    } catch {
      setReserve0('0')
      setReserve1('0')
    }
  }, [currentChainConfig])

  const fetchSwapPreview = useCallback(async () => {
    const amount = parseAmount(swapAmount)
    if (amount === 0n || !account || !currentChainConfig) {
      setSwapAmountOut('')
      return
    }
    const cacheKey = CACHE_KEYS.SWAP_PREVIEW + swapTokenIn + '_' + swapAmount + '_' + currentChainConfig.chainId
    const cached = cacheGet<string>(cacheKey)
    if (cached) {
      setSwapAmountOut(cached)
      return
    }
    try {
      const provider = getProvider()
      if (!provider) return
      const amm = new Contract(currentChainConfig.contracts.ammPool, AMM_ABI, provider)
      const tokenIn = swapTokenIn === 'token0' ? currentChainConfig.contracts.token0 : currentChainConfig.contracts.token1
      const out = await amm.getAmountOut(tokenIn, amount)
      const outStr = formatTokenAmount(out)
      setSwapAmountOut(outStr)
      cacheSet(cacheKey, outStr, CACHE_TTL.SWAP_PREVIEW)
    } catch {
      setSwapAmountOut('')
    }
  }, [account, swapAmount, swapTokenIn])

  useEffect(() => {
    fetchSwapPreview()
  }, [fetchSwapPreview])

  useEffect(() => {
    if (account) fetchReserves()
  }, [account, fetchReserves])

  const handleSwap = useCallback(async () => {
    const amount = parseAmount(swapAmount)
    if (amount === 0n) {
      setError('请输入数量')
      return
    }
    if (!currentChainConfig || currentChainConfig.contracts.ammPool === '0x0000000000000000000000000000000000000000') {
      setError('当前链的 AMM 池尚未部署，请切换到已部署的链（如 Sepolia）')
      return
    }
    setError(null)
    setLoadingSwap(true)
    try {
      const tokenIn = swapTokenIn === 'token0' ? currentChainConfig.contracts.token0 : currentChainConfig.contracts.token1
      await withSigner(async (signer) => {
        const token = new Contract(tokenIn, ERC20_ABI, signer)
        const bal = await token.balanceOf(account!)
        if (bal < amount) throw new Error(`余额不足，钱包仅有 ${formatTokenAmount(bal)}`)
        const amm = new Contract(currentChainConfig.contracts.ammPool, AMM_ABI, signer)
        const allowance = await token.allowance(account!, currentChainConfig.contracts.ammPool)
        if (allowance < amount) {
          await (await token.approve(currentChainConfig.contracts.ammPool, 0n)).wait()
          await (await token.approve(currentChainConfig.contracts.ammPool, amount)).wait()
        }
        await (await amm.swap(tokenIn, amount)).wait()
      })
      setSwapAmount('')
      setSwapAmountOut('')
      cacheInvalidate(CACHE_KEYS.BALANCE)
      cacheInvalidate(CACHE_KEYS.RESERVES)
      await fetchReserves()
    } catch (e) {
      setError(formatError(e))
    } finally {
      setLoadingSwap(false)
    }
  }, [account, swapAmount, swapTokenIn, fetchReserves, currentChainConfig])

  const handleAddLiquidity = useCallback(async () => {
      const amt0 = parseAmount(addLiqAmount0)
      const amt1 = parseAmount(addLiqAmount1)
      if (amt0 === 0n || amt1 === 0n) {
        setError('请输入 Token0 和 Token1 的数量')
        return
      }
      if (!currentChainConfig || currentChainConfig.contracts.ammPool === '0x0000000000000000000000000000000000000000') {
        setError('当前链的 AMM 池尚未部署，请切换到已部署的链（如 Sepolia）')
        return
      }
      setError(null)
      setLoadingAddLiq(true)
      try {
        await withSigner(async (signer) => {
          const token0C = new Contract(currentChainConfig.contracts.token0, ERC20_ABI, signer)
          const token1C = new Contract(currentChainConfig.contracts.token1, ERC20_ABI, signer)
          const amm = new Contract(currentChainConfig.contracts.ammPool, AMM_ABI, signer)
          await Promise.all([
            token0C.approve(currentChainConfig.contracts.ammPool, amt0),
            token1C.approve(currentChainConfig.contracts.ammPool, amt1),
          ]).then((txs) => Promise.all(txs.map((tx) => tx.wait())))
          await (await amm.addLiquidity(amt0, amt1)).wait()
        })
        setAddLiqAmount0('')
        setAddLiqAmount1('')
        cacheInvalidate(CACHE_KEYS.RESERVES)
        await fetchReserves()
      } catch (e) {
        setError(formatError(e))
      } finally {
        setLoadingAddLiq(false)
      }
    }, [account, addLiqAmount0, addLiqAmount1, fetchReserves, currentChainConfig])

  const handleMaxDeposit = useCallback(() => {
    if (walletTokenBalance) setDepositAmount(walletTokenBalance)
    else setError('请先查询该代币余额')
  }, [walletTokenBalance])

  const handleMaxWithdraw = useCallback(() => {
    if (vaultBalance) setWithdrawAmount(vaultBalance)
    else setError('请先查询该代币余额')
  }, [vaultBalance])

  const fetchTokenBalance = useCallback(async (tokenAddress: string): Promise<string> => {
    const provider = getProvider()
    if (!provider || !account) return '0'
    const token = new Contract(tokenAddress, ERC20_ABI, provider)
    const bal = await token.balanceOf(account)
    return formatTokenAmount(bal)
  }, [account])

  const handleMaxSwap = useCallback(async () => {
    if (!account || !currentChainConfig) return
    setError(null)
    try {
      const addr = swapTokenIn === 'token0' ? currentChainConfig.contracts.token0 : currentChainConfig.contracts.token1
      setSwapAmount(await fetchTokenBalance(addr))
    } catch (e) {
      setError(formatError(e))
    }
  }, [account, swapTokenIn, fetchTokenBalance, currentChainConfig])

  const handleMaxAddLiq0 = useCallback(async () => {
    if (!account || !currentChainConfig) return
    setError(null)
    try {
      setAddLiqAmount0(await fetchTokenBalance(currentChainConfig.contracts.token0))
    } catch (e) {
      setError(formatError(e))
    }
  }, [account, fetchTokenBalance, currentChainConfig])

  const handleMaxAddLiq1 = useCallback(async () => {
    if (!account || !currentChainConfig) return
    setError(null)
    try {
      setAddLiqAmount1(await fetchTokenBalance(currentChainConfig.contracts.token1))
    } catch (e) {
      setError(formatError(e))
    }
  }, [account, fetchTokenBalance, currentChainConfig])

  useEffect(() => {
    if (!account) return
    const provider = getProvider()
    if (!provider) return
    provider.getBalance(account).then((b) => setEthBalance(formatTokenAmount(b)))
  }, [account])

  return (
    <div className="app">
      {!isOnline && (
        <div className="offline-banner" role="status">
          当前处于离线状态，请检查网络后重试
        </div>
      )}
      <div className="app-header-top">
        <div>
          <h1>P2P 交易所</h1>
          <p className="subtitle">
            {currentChainConfig?.name || '未知网络'} · 连钱包 · 存提 · Swap · 添加流动性
          </p>
        </div>
        <ChainSwitcher
          currentChainId={currentChainId}
          onChainChange={switchChain}
        />
      </div>

      <div className="card" style={{ marginBottom: '0.5rem' }}>
        <p className="hint" style={{ margin: 0 }}>当前合约（验证用）</p>
        <div className="row"><span className="label">网络</span><span className="value">{currentChainConfig?.name || '未知'}</span></div>
        <div className="row"><span className="label">AMM 池</span><span className="value mono" style={{ fontSize: '0.75rem' }}>{AMM_POOL_ADDRESS}</span></div>
        <div className="row"><span className="label">Governance</span><span className="value mono" style={{ fontSize: '0.75rem' }}>{GOVERNANCE_ADDRESS}</span></div>
        <div className="row"><span className="label">Settlement</span><span className="value mono" style={{ fontSize: '0.75rem' }}>{SETTLEMENT_ADDRESS}</span></div>
      </div>

      <ContributionSection account={account} />

      {!account ? (
        <>
          <button className="btn primary" onClick={connectWallet}>
            连接钱包
          </button>
          {isElectron() && (
            <p className="hint" style={{ marginTop: '0.5rem' }}>
              桌面版需先在 Chrome 或 Edge 中安装 MetaMask，本应用会自动加载。若无法连接，请使用浏览器打开{' '}
              <a href="https://p2p-p2p.github.io/p2p/" target="_blank" rel="noopener noreferrer">p2p-p2p.github.io/p2p</a>。
            </p>
          )}
        </>
      ) : (
        <div className="card">
          <div className="row">
            <span className="label">当前账户</span>
            <span className="value mono">{shortAddress(account)}</span>
          </div>
          <div className="row">
            <span className="label">钱包 ETH 余额</span>
            <span className="value">{ethBalance} ETH</span>
          </div>
        </div>
      )}

      {account && (
        <>
          <Navigation activeTab={activeTab} onTabChange={setActiveTab} account={account} />

          {(activeTab === 'vault' || activeTab === 'swap') && (
            <div className="card vault-section">
            <h2>代币与 Vault 余额</h2>
            <p className="hint">输入 ERC20 代币合约地址，或点下方快捷填入。代币地址与 Swap 方向会保存在本机，刷新后仍保留；清除浏览器/缓存会丢失。</p>
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
              <button type="button" className="btn-quick" onClick={() => { if (currentChainConfig) { setTokenAddress(currentChainConfig.contracts.token0); setVaultBalance(''); setWalletTokenBalance('') } }}>Token A (TKA)</button>
              <button type="button" className="btn-quick" onClick={() => { if (currentChainConfig) { setTokenAddress(currentChainConfig.contracts.token1); setVaultBalance(''); setWalletTokenBalance('') } }}>Token B (TKB)</button>
            </div>
            <button
              className="btn secondary"
              onClick={fetchBalances}
              disabled={loading || !isValidAddress(tokenAddr)}
            >
              {loading ? '查询中…' : '查询余额'}
            </button>
            {(vaultBalance !== '' || walletTokenBalance !== '') && !error && (
              <div className="balances">
                <div className="row result">
                  <span className="label">钱包中该代币</span>
                  <span className="value">{walletTokenBalance}</span>
                </div>
                <div className="row result">
                  <span className="label">Vault 中该代币</span>
                  <span className="value">{vaultBalance}</span>
                </div>
              </div>
            )}
          </div>

          <div className="card vault-section">
            <h2>存入 Vault</h2>
            <p className="hint">先 approve 再 deposit，需有该代币余额</p>
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
            <h2>从 Vault 提取</h2>
            <p className="hint">从 Vault 提回钱包，不超过 Vault 中该代币余额</p>
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
          )}

          {activeTab === 'orderbook' && (
            <OrderBookSection
              account={account}
              getSigner={async () => {
                try {
                  const p = getProvider()
                  if (!p) return null
                  return await p.getSigner()
                } catch {
                  return null
                }
              }}
            />
          )}

          {activeTab === 'swap' && (
            <div className="card vault-section">
              <h2>AMM Swap</h2>
            <p className="hint">Token A ↔ Token B，0.01% 手续费，单笔最高等值 1 USD。池子需有流动性。</p>
            <div className="row">
              <span className="label">池子储备</span>
              <span className="value mono">TKA: {reserve0} · TKB: {reserve1}</span>
            </div>
            <select
              value={swapTokenIn}
              onChange={(e) => setSwapTokenIn(e.target.value as 'token0' | 'token1')}
              className="input"
            >
              <option value="token0">TKA → TKB</option>
              <option value="token1">TKB → TKA</option>
            </select>
            <div className="input-row">
              <input
                type="text"
                placeholder="输入数量"
                value={swapAmount}
                onChange={(e) => setSwapAmount(e.target.value)}
                className="input"
              />
              <button type="button" className="btn-max" onClick={handleMaxSwap}>最大</button>
            </div>
            {swapAmountOut && <div className="row result"><span className="label">预计获得</span><span className="value">{swapAmountOut}</span></div>}
            <button
              className="btn primary"
              onClick={handleSwap}
              disabled={loadingSwap || !swapAmount.trim() || parseAmount(swapAmount) === 0n}
            >
              {loadingSwap ? '处理中…' : 'Swap'}
            </button>
            </div>
          )}

          {activeTab === 'governance' && (
            <GovernanceErrorBoundary account={account}>
              <GovernanceSection account={account} />
            </GovernanceErrorBoundary>
          )}

          {activeTab === 'contribution' && (
            <ContributionSection account={account} />
          )}

          {activeTab === 'bridge' && (
            <CrossChainBridge account={account} currentChainId={currentChainId} />
          )}

          {(activeTab === 'vault' || activeTab === 'swap') && (
            <div className="card vault-section">
              <h2>添加流动性</h2>
            <p className="hint">向 AMM 池添加 Token A 和 Token B，需有该代币余额</p>
            <div className="input-row">
              <input
                type="text"
                placeholder="Token A 数量"
                value={addLiqAmount0}
                onChange={(e) => setAddLiqAmount0(e.target.value)}
                className="input"
              />
              <button type="button" className="btn-max" onClick={handleMaxAddLiq0}>最大</button>
            </div>
            <div className="input-row">
              <input
                type="text"
                placeholder="Token B 数量"
                value={addLiqAmount1}
                onChange={(e) => setAddLiqAmount1(e.target.value)}
                className="input"
              />
              <button type="button" className="btn-max" onClick={handleMaxAddLiq1}>最大</button>
            </div>
            <button
              className="btn secondary"
              onClick={handleAddLiquidity}
              disabled={loadingAddLiq || !addLiqAmount0.trim() || !addLiqAmount1.trim()}
            >
              {loadingAddLiq ? '处理中…' : '添加流动性'}
            </button>
            </div>
          )}

        </>
      )}

      <ErrorDisplay
        error={error}
        onRetry={() => {
          setError(null)
          if (account && isValidAddress(tokenAddr)) fetchBalances()
          fetchReserves()
        }}
        onDismiss={() => setError(null)}
      />
    </div>
  )
}

export default App
