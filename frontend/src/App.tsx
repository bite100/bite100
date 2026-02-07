import { useState, useEffect, useCallback, Component, type ReactNode } from 'react'
import { BrowserProvider, Contract } from 'ethers'
import { CHAIN_ID, RPC_URL, VAULT_ADDRESS, VAULT_ABI, ERC20_ABI, AMM_ABI, TOKEN0_ADDRESS, TOKEN1_ADDRESS, AMM_POOL_ADDRESS, GOVERNANCE_ADDRESS, SETTLEMENT_ADDRESS } from './config'
import { GovernanceSection } from './GovernanceSection'
import { getEthereum, formatTokenAmount, shortAddress, isValidAddress } from './utils'
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

/** 将合约/钱包错误转为用户可读提示 */
function formatError(e: unknown): string {
  if (e == null) return '操作失败'
  const err = e as { code?: number; reason?: string; message?: string; shortMessage?: string; data?: unknown }
  const msg = err.reason ?? err.shortMessage ?? err.message ?? String(e)
  if (err.code === 4001 || msg.toLowerCase().includes('user rejected') || msg.toLowerCase().includes('denied')) return '您已拒绝签名或切换网络'
  if (msg.includes('CALL_EXCEPTION')) {
    if (msg.includes('insufficient balance')) return '余额不足'
    if (msg.includes('insufficient allowance')) return '授权额度不足，请先 Approve'
    if (msg.includes('execution reverted')) {
      const m = msg.match(/reverted[:\s]+["']?([^"']+)["']?/i) || msg.match(/reason="([^"]+)"/)
      if (m?.[1]) return m[1]
    }
  }
  if (msg.includes('network') || msg.includes('chain')) return '网络错误，请确认已切换到 Sepolia'
  if (msg.length > 80) return msg.slice(0, 77) + '...'
  return msg
}

function App() {
  const [account, setAccount] = useState<string | null>(null)
  const [ethBalance, setEthBalance] = useState<string>('')
  const [vaultBalance, setVaultBalance] = useState<string>('')
  const [walletTokenBalance, setWalletTokenBalance] = useState<string>('')
  const [tokenAddress, setTokenAddress] = useState<string>('')
  const [depositAmount, setDepositAmount] = useState<string>('')
  const [withdrawAmount, setWithdrawAmount] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [loadingDeposit, setLoadingDeposit] = useState(false)
  const [loadingWithdraw, setLoadingWithdraw] = useState(false)
  const [loadingSwap, setLoadingSwap] = useState(false)
  const [loadingAddLiq, setLoadingAddLiq] = useState(false)
  const [swapTokenIn, setSwapTokenIn] = useState<'token0' | 'token1'>('token0')
  const [swapAmount, setSwapAmount] = useState<string>('')
  const [swapAmountOut, setSwapAmountOut] = useState<string>('')
  const [addLiqAmount0, setAddLiqAmount0] = useState<string>('')
  const [addLiqAmount1, setAddLiqAmount1] = useState<string>('')
  const [reserve0, setReserve0] = useState<string>('')
  const [reserve1, setReserve1] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  const connectWallet = useCallback(async () => {
    setError(null)
    try {
      const ethereum = getEthereum()
      if (!ethereum) {
        setError('请安装 MetaMask 或其他钱包扩展')
        return
      }
      const provider = new BrowserProvider(ethereum)
      const accounts = (await ethereum.request({ method: 'eth_requestAccounts' })) as string[]
      if (!accounts.length) {
        setError('未获取到账户')
        return
      }
      const chainIdRaw = await ethereum.request({ method: 'eth_chainId' })
      const chainId = typeof chainIdRaw === 'string' ? parseInt(chainIdRaw, 16) : Number(chainIdRaw)
      if (Number(chainId) !== CHAIN_ID) {
        try {
          await ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: `0x${CHAIN_ID.toString(16)}` }],
          })
        } catch (e) {
          await ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: `0x${CHAIN_ID.toString(16)}`,
              chainName: 'Sepolia',
              nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
              rpcUrls: [RPC_URL],
              blockExplorerUrls: ['https://sepolia.etherscan.io'],
            }],
          })
        }
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
    if (!account || !isValidAddress(tokenAddr)) return
    setError(null)
    setLoading(true)
    try {
      const ethereum = getEthereum()
      if (!ethereum) throw new Error('未检测到钱包')
      const provider = new BrowserProvider(ethereum)
      const vault = new Contract(VAULT_ADDRESS, VAULT_ABI, provider)
      const token = new Contract(tokenAddr, ERC20_ABI, provider)
      const [vBal, wBal] = await Promise.all([
        vault.balanceOf(tokenAddr, account),
        token.balanceOf(account),
      ])
      setVaultBalance(formatTokenAmount(vBal))
      setWalletTokenBalance(formatTokenAmount(wBal))
    } catch (e) {
      setVaultBalance('')
      setWalletTokenBalance('')
      setError(formatError(e))
    } finally {
      setLoading(false)
    }
  }, [account, tokenAddr])

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
      const ethereum = getEthereum()
      if (!ethereum) throw new Error('未检测到钱包')
      const provider = new BrowserProvider(ethereum)
      const signer = await provider.getSigner()
      const token = new Contract(tokenAddr, ERC20_ABI, signer)
      const vault = new Contract(VAULT_ADDRESS, VAULT_ABI, signer)
      const txApprove = await token.approve(VAULT_ADDRESS, amount)
      await txApprove.wait()
      const txDeposit = await vault.deposit(tokenAddr, amount)
      await txDeposit.wait()
      setDepositAmount('')
      await fetchBalances()
    } catch (e) {
      setError(formatError(e))
    } finally {
      setLoadingDeposit(false)
    }
  }, [account, tokenAddr, depositAmount, fetchBalances])

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
      const ethereum = getEthereum()
      if (!ethereum) throw new Error('未检测到钱包')
      const provider = new BrowserProvider(ethereum)
      const signer = await provider.getSigner()
      const vault = new Contract(VAULT_ADDRESS, VAULT_ABI, signer)
      const tx = await vault.withdraw(tokenAddr, amount)
      await tx.wait()
      setWithdrawAmount('')
      await fetchBalances()
    } catch (e) {
      setError(formatError(e))
    } finally {
      setLoadingWithdraw(false)
    }
  }, [account, tokenAddr, withdrawAmount, fetchBalances])

  const fetchReserves = useCallback(async () => {
    try {
      const ethereum = getEthereum()
      if (!ethereum) return
      const provider = new BrowserProvider(ethereum)
      const amm = new Contract(AMM_POOL_ADDRESS, AMM_ABI, provider)
      const [r0, r1] = await Promise.all([amm.reserve0(), amm.reserve1()])
      setReserve0(formatTokenAmount(r0))
      setReserve1(formatTokenAmount(r1))
    } catch {
      setReserve0('0')
      setReserve1('0')
    }
  }, [])

  const fetchSwapPreview = useCallback(async () => {
    const amount = parseAmount(swapAmount)
    if (amount === 0n || !account) {
      setSwapAmountOut('')
      return
    }
    try {
      const ethereum = getEthereum()
      if (!ethereum) return
      const provider = new BrowserProvider(ethereum)
      const amm = new Contract(AMM_POOL_ADDRESS, AMM_ABI, provider)
      const tokenIn = swapTokenIn === 'token0' ? TOKEN0_ADDRESS : TOKEN1_ADDRESS
      const out = await amm.getAmountOut(tokenIn, amount)
      setSwapAmountOut(formatTokenAmount(out))
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
    setError(null)
    setLoadingSwap(true)
    try {
      const tokenIn = swapTokenIn === 'token0' ? TOKEN0_ADDRESS : TOKEN1_ADDRESS
      const ethereum = getEthereum()
      if (!ethereum) throw new Error('未检测到钱包')
      const provider = new BrowserProvider(ethereum)
      const signer = await provider.getSigner()
      const token = new Contract(tokenIn, ERC20_ABI, signer)
      const bal = await token.balanceOf(account!)
      if (bal < amount) throw new Error(`余额不足，钱包仅有 ${formatTokenAmount(bal)}`)
      const amm = new Contract(AMM_POOL_ADDRESS, AMM_ABI, signer)
      const allowance = await token.allowance(account!, AMM_POOL_ADDRESS)
      if (allowance < amount) {
        await (await token.approve(AMM_POOL_ADDRESS, 0n)).wait()
        await (await token.approve(AMM_POOL_ADDRESS, amount)).wait()
      }
      await (await amm.swap(tokenIn, amount)).wait()
      setSwapAmount('')
      setSwapAmountOut('')
      await fetchReserves()
    } catch (e) {
      setError(formatError(e))
    } finally {
      setLoadingSwap(false)
    }
  }, [account, swapAmount, swapTokenIn, fetchReserves])

  const handleAddLiquidity = useCallback(async () => {
    const amt0 = parseAmount(addLiqAmount0)
    const amt1 = parseAmount(addLiqAmount1)
    if (amt0 === 0n || amt1 === 0n) {
      setError('请输入 Token0 和 Token1 的数量')
      return
    }
    setError(null)
    setLoadingAddLiq(true)
    try {
      const ethereum = getEthereum()
      if (!ethereum) throw new Error('未检测到钱包')
      const provider = new BrowserProvider(ethereum)
      const signer = await provider.getSigner()
      const token0C = new Contract(TOKEN0_ADDRESS, ERC20_ABI, signer)
      const token1C = new Contract(TOKEN1_ADDRESS, ERC20_ABI, signer)
      const amm = new Contract(AMM_POOL_ADDRESS, AMM_ABI, signer)
      await Promise.all([
        token0C.approve(AMM_POOL_ADDRESS, amt0),
        token1C.approve(AMM_POOL_ADDRESS, amt1),
      ]).then((txs) => Promise.all(txs.map((tx) => tx.wait())))
      await (await amm.addLiquidity(amt0, amt1)).wait()
      setAddLiqAmount0('')
      setAddLiqAmount1('')
      await fetchReserves()
    } catch (e) {
      setError(formatError(e))
    } finally {
      setLoadingAddLiq(false)
    }
  }, [account, addLiqAmount0, addLiqAmount1, fetchReserves])

  const handleMaxDeposit = useCallback(() => {
    if (walletTokenBalance) setDepositAmount(walletTokenBalance)
    else setError('请先查询该代币余额')
  }, [walletTokenBalance])

  const handleMaxWithdraw = useCallback(() => {
    if (vaultBalance) setWithdrawAmount(vaultBalance)
    else setError('请先查询该代币余额')
  }, [vaultBalance])

  const fetchTokenBalance = useCallback(async (tokenAddress: string): Promise<string> => {
    const ethereum = getEthereum()
    if (!ethereum || !account) return '0'
    const provider = new BrowserProvider(ethereum)
    const token = new Contract(tokenAddress, ERC20_ABI, provider)
    const bal = await token.balanceOf(account)
    return formatTokenAmount(bal)
  }, [account])

  const handleMaxSwap = useCallback(async () => {
    if (!account) return
    setError(null)
    try {
      const addr = swapTokenIn === 'token0' ? TOKEN0_ADDRESS : TOKEN1_ADDRESS
      setSwapAmount(await fetchTokenBalance(addr))
    } catch (e) {
      setError(formatError(e))
    }
  }, [account, swapTokenIn, fetchTokenBalance])

  const handleMaxAddLiq0 = useCallback(async () => {
    if (!account) return
    setError(null)
    try {
      setAddLiqAmount0(await fetchTokenBalance(TOKEN0_ADDRESS))
    } catch (e) {
      setError(formatError(e))
    }
  }, [account, fetchTokenBalance])

  const handleMaxAddLiq1 = useCallback(async () => {
    if (!account) return
    setError(null)
    try {
      setAddLiqAmount1(await fetchTokenBalance(TOKEN1_ADDRESS))
    } catch (e) {
      setError(formatError(e))
    }
  }, [account, fetchTokenBalance])

  useEffect(() => {
    if (!account) return
    const ethereum = getEthereum()
    if (!ethereum) return
    const provider = new BrowserProvider(ethereum)
    provider.getBalance(account).then((b) => setEthBalance(formatTokenAmount(b)))
  }, [account])

  return (
    <div className="app">
      <h1>P2P 交易所</h1>
      <p className="subtitle">Sepolia 测试网 · 连钱包 · 存提 · Swap · 添加流动性</p>

      <div className="card" style={{ marginBottom: '0.5rem' }}>
        <p className="hint" style={{ margin: 0 }}>当前合约（验证用）</p>
        <div className="row"><span className="label">AMM 池</span><span className="value mono" style={{ fontSize: '0.75rem' }}>{AMM_POOL_ADDRESS}</span></div>
        <div className="row"><span className="label">Governance</span><span className="value mono" style={{ fontSize: '0.75rem' }}>{GOVERNANCE_ADDRESS}</span></div>
        <div className="row"><span className="label">Settlement</span><span className="value mono" style={{ fontSize: '0.75rem' }}>{SETTLEMENT_ADDRESS}</span></div>
      </div>

      {!account ? (
        <button className="btn primary" onClick={connectWallet}>
          连接钱包
        </button>
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
          <div className="card vault-section">
            <h2>代币与 Vault 余额</h2>
            <p className="hint">输入 ERC20 代币合约地址，或点下方快捷填入</p>
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
              <button type="button" className="btn-quick" onClick={() => { setTokenAddress(TOKEN0_ADDRESS); setVaultBalance(''); setWalletTokenBalance('') }}>Token A (TKA)</button>
              <button type="button" className="btn-quick" onClick={() => { setTokenAddress(TOKEN1_ADDRESS); setVaultBalance(''); setWalletTokenBalance('') }}>Token B (TKB)</button>
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

          <div className="card vault-section">
            <h2>AMM Swap</h2>
            <p className="hint">Token A ↔ Token B，0.05% 手续费。池子需有流动性。</p>
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

          <GovernanceErrorBoundary account={account}>
            <GovernanceSection account={account} />
          </GovernanceErrorBoundary>

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
        </>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  )
}

export default App
