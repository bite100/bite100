/**
 * 资产页（第 31 轮 v2；第 53 轮下线做市金库产品面后为单页总览）。
 * 总览 = 估值头卡（只汇总有已验证 Chainlink 价格的代币，无价明示排除）→ 快捷动作 →
 * 持仓分布 → 余额列表（三数：Vault 可用 / 锁定中 / 钱包）→ 查询其他代币入口。
 * 存入 / 提取 / 查询其他代币都是动作触发的子视图；存提逻辑与文案沿用原资产页
 * （Vault deposit/withdraw + 授权口径不变），只是搬进子视图。
 * 第 53 轮：做市金库（MakerVault）产品退役（Ren 2026-11-09 拍板）——
 * 金库页签、快捷入口与做市金库卡一并删除，用户不再有入口到达金库页；
 * 合约代码保留在仓库，通用 ERC-1271 合约钱包验签不受影响。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Select } from '@mantine/core'
import { Contract, JsonRpcProvider, formatUnits } from 'ethers'
import type { ChainConfig } from '../config/chains'
import { VAULT_ABI, ERC20_ABI } from '../config'
import { TRADE_PAIRS, DEFAULT_PAIR } from '../config/pairs'
import { getProvider, withSigner, formatError, formatTokenAmount, isValidAddress, shortAddress } from '../utils'
import { StandardConnect } from './StandardConnect'
import { MobileConnectHint } from './MobileConnectHint'
import { AddNetworkButton } from './AddNetworkButton'
import { tokenMeta } from './markets/marketsData'
import {
  valueTokens,
  loadSnapshots,
  recordSnapshot,
  changeVs24h,
  fmtUsd,
  type TokenBalance,
} from './assets/valuation'
import { SparklineChart } from './SparklineChart'
import { ensureAllowance, parseAmountInput } from './assets/tokenOps'
import { evaluateFeedReading, getFeedConfig, readChainlinkFeed } from '../services/referencePrice'
import { CHANNEL_DISCLOSURES } from '../services/defaultBridge/disclosures'
import { loadDeliveries } from '../services/defaultBridge/deliveries'
import { loadSettings } from '../services/defaultBridge/settings'
import { getChainConfig } from '../config/chains'
import './AssetsPage.css'

type AssetsView = 'overview' | 'deposit' | 'withdraw' | 'query'

interface AssetsPageProps {
  account: string | null
  chainConfig: ChainConfig | null
  chainId: number | null
  connectionLabel: string
  ethBalance: string
  onDisconnect: () => void
  goTrade: (pair: string) => void
  /** 第四十一轮：跨链交付设置入口行（设计 §2.2）→ 跳桥页顶部设置区 */
  onOpenBridge?: () => void
}

const fmtQty = (n: number): string =>
  n.toLocaleString('en-US', { maximumFractionDigits: n !== 0 && Math.abs(n) < 1 ? 6 : 4 })

const DIST_COLORS = ['#ff007a', '#089981', '#7a5af8', '#f0b90b', '#64748b', '#0ea5e9', '#d92d20', '#9333ea']

export function AssetsPage({ account, chainConfig, chainId, connectionLabel, ethBalance, onDisconnect, goTrade, onOpenBridge }: AssetsPageProps) {
  const [view, setView] = useState<AssetsView>('overview')
  const [transferSymbol, setTransferSymbol] = useState('USDT')
  const [balances, setBalances] = useState<TokenBalance[] | null>(null)
  const [prices, setPrices] = useState<Map<string, number>>(new Map([['USDT', 1]]))
  const [refreshTick, setRefreshTick] = useState(0)
  const [hideTotal, setHideTotal] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)

  /* ---------- 第四十一轮：跨链交付摘要（入口行）+ 在途金额标注（设计 §2.2 / §4.2） ---------- */
  const deliverySettings = account ? loadSettings(account) : null
  const deliverySummary = !account
    ? ''
    : !deliverySettings?.defaultChannel
      ? '未设置'
      : `${CHANNEL_DISCLOSURES[deliverySettings.defaultChannel].name}${deliverySettings.standingAuth ? '（自动交付开）' : '（自动交付关）'}`
  /** 当前链上「交付中/发起中」的在途金额（按资产汇总 wei），渲染时从本地交付记录现读 */
  const inFlightByAsset = (() => {
    const map = new Map<string, { wei: bigint; channelName: string; homeName: string }>()
    if (!account || chainId == null) return map
    for (const r of loadDeliveries(account)) {
      if (r.settleChainId !== chainId) continue
      if (r.status !== 'in-flight' && r.status !== 'initiating') continue
      const prev = map.get(r.asset)
      map.set(r.asset, {
        wei: (prev?.wei ?? 0n) + BigInt(r.amountWei),
        channelName: r.channel ? CHANNEL_DISCLOSURES[r.channel].name : '通道',
        homeName: getChainConfig(r.homeChainId)?.name ?? `${r.homeChainId}`,
      })
    }
    return map
  })()

  const symbols = useMemo(
    () => (chainConfig?.tokens ? Object.keys(chainConfig.tokens) : []),
    [chainConfig],
  )

  /* ---------- 余额：当前链全部登记代币的 钱包 / Vault 总额·可用·锁定 ---------- */
  useEffect(() => {
    if (!account || !chainConfig || symbols.length === 0) {
      setBalances(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const provider = new JsonRpcProvider(chainConfig.rpcUrl)
        const vault = new Contract(chainConfig.contracts.vault, VAULT_ABI, provider)
        const rows = await Promise.all(
          symbols.map(async (symbol) => {
            const addr = chainConfig.tokens![symbol]
            const token = new Contract(addr, ERC20_ABI, provider)
            const total = (await vault.balanceOf(addr, account)) as bigint
            const [w, avail, locked] = await Promise.all([
              token.balanceOf(account) as Promise<bigint>,
              vault.availableBalance(account, addr).catch(() => total) as Promise<bigint>,
              vault.locked(account, addr).catch(() => 0n) as Promise<bigint>,
            ])
            const num = (v: bigint) => Number(formatUnits(v, 18))
            return {
              symbol,
              wallet: num(w),
              vaultTotal: num(total),
              vaultAvailable: num(avail),
              vaultLocked: num(locked),
            } satisfies TokenBalance
          }),
        )
        if (!cancelled) setBalances(rows)
      } catch {
        if (!cancelled) setBalances(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [account, chainConfig, symbols, refreshTick])

  /* ---------- 已验证价格：USDT=1，其余只认本链 Chainlink 喂价（新鲜才用） ---------- */
  useEffect(() => {
    if (!chainConfig) return
    let cancelled = false
    ;(async () => {
      const next = new Map<string, number>([['USDT', 1]])
      const nowSec = Math.floor(Date.now() / 1000)
      await Promise.all(
        symbols
          .filter((s) => s !== 'USDT')
          .map(async (symbol) => {
            const feed =
              getFeedConfig(chainConfig.chainId, `${symbol}/USDT`) ??
              getFeedConfig(chainConfig.chainId, `${symbol}/USD`)
            if (!feed) return
            try {
              const reading = await readChainlinkFeed(chainConfig.chainId, feed.address)
              const ev = evaluateFeedReading(reading, nowSec, feed.heartbeatSec)
              if (ev.kind === 'ok') next.set(symbol, ev.price)
            } catch {
              // 读不到就不定价：该代币按无价处理并在页面明示，不编造
            }
          }),
      )
      if (!cancelled) setPrices(next)
    })()
    return () => {
      cancelled = true
    }
  }, [chainConfig, symbols])

  const valuation = useMemo(
    () => (balances ? valueTokens(balances, prices) : null),
    [balances, prices],
  )

  /* ---------- 24h 估值快照（本地记录同口径总额） ---------- */
  const [snaps, setSnaps] = useState(() => loadSnapshots())
  useEffect(() => {
    if (!valuation || !account) return
    setSnaps((prev) => recordSnapshot(prev, valuation.totalValue, Date.now()))
  }, [valuation, account])
  const change24 = useMemo(
    () => (valuation ? changeVs24h(snaps, valuation.totalValue, Date.now()) : null),
    [snaps, valuation],
  )

  const openTransfer = (mode: 'deposit' | 'withdraw', symbol: string) => {
    setTransferSymbol(symbol)
    setView(mode)
  }

  const pairForToken = (symbol: string): string | null =>
    TRADE_PAIRS.find((p) => p.split('/').includes(symbol)) ?? null

  if (!account) {
    return (
      <div className="assets-page">
        <div className="card connect-gate">
          <h2>连接钱包后管理资产</h2>
          <p className="hint">
            比特100 是链无关的 P2P 去中心化交易所：资产在哪条链，连接钱包即可交易。行情、盘口与公开数据无需连接即可浏览；下单、存提与领取奖励需要连接钱包。gas
            由中继代付、结算时由交易双方对半分摊，无需自备原生代币。当前运行于测试网。存入、提取与余额查询需要连接钱包。
          </p>
          <div className="connect-gate-actions">
            <StandardConnect />
            <MobileConnectHint />
            {chainId !== undefined && chainId !== null && (
              <AddNetworkButton chainId={chainId} className="add-network-below-connect" />
            )}
          </div>
        </div>
      </div>
    )
  }

  if (view === 'deposit' || view === 'withdraw') {
    return (
      <div className="assets-page">
        <TransferView
          mode={view}
          symbol={transferSymbol}
          symbols={symbols}
          chainConfig={chainConfig}
          account={account}
          balances={balances}
          onBack={() => setView('overview')}
          onDone={() => setRefreshTick((n) => n + 1)}
        />
      </div>
    )
  }

  if (view === 'query') {
    return (
      <div className="assets-page">
        <QueryTokenView chainConfig={chainConfig} account={account} onBack={() => setView('overview')} />
      </div>
    )
  }

  const visibleRows = (valuation?.rows ?? [])
    .filter((r) => r.symbol === 'USDT' || r.wallet + r.vaultTotal > 0)
    .sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1))

  return (
    <div className="assets-page">
      <section className="card assets-hero">
        <div className="assets-hero-label">
          总资产估值（Vault + 钱包）
          <button
            type="button"
            className="assets-eye"
            onClick={() => setHideTotal((v) => !v)}
            aria-label={hideTotal ? '显示估值' : '隐藏估值'}
          >
            {hideTotal ? '🙈' : '👁'}
          </button>
        </div>
        <div className="assets-hero-value num">
          {hideTotal ? '******' : valuation ? `${fmtUsd(valuation.totalValue)} USDT` : '加载中…'}
        </div>
        {!hideTotal && valuation && <div className="assets-hero-usd num">≈ ${fmtUsd(valuation.totalValue)}</div>}
        <div className="assets-hero-change">
          <span>24h 估值变化（按参考价）</span>
          {change24 ? (
            <span className="assets-change-wrap">
              <b className={`num ${change24.pct >= 0 ? 'assets-up' : 'assets-down'}`}>
                {change24.pct >= 0 ? '+' : ''}
                {change24.pct.toFixed(2)}%
              </b>
              <span className="assets-spark">
                <SparklineChart points={change24.spark} up={change24.pct >= 0} height={20} />
              </span>
            </span>
          ) : (
            <span className="assets-dim">暂无 24 小时前的快照，记录中</span>
          )}
        </div>
        <p className="assets-fineprint">
          按 Chainlink 参考价折算
          {valuation && valuation.unpricedHeld.length > 0
            ? `；${valuation.unpricedHeld.join('、')} 暂无已验证参考价，未计入总估值`
            : ''}
          。本站暂无持仓成本数据，不提供「今日盈亏」，估值变化按参考价计算。资金路径：钱包 → 存入 Vault →
          用 Vault 余额下单结算 → 提取回钱包。
        </p>
        <button type="button" className="assets-account-toggle" onClick={() => setAccountOpen((v) => !v)} aria-expanded={accountOpen}>
          账户详情（{shortAddress(account)}）{accountOpen ? '⌄' : '›'}
        </button>
        {accountOpen && (
          <div className="assets-account-rows">
            <div className="kv">
              <span className="k">当前账户</span>
              <span className="v num">{shortAddress(account)}</span>
            </div>
            <div className="kv">
              <span className="k">连接方式</span>
              <span className="v">{connectionLabel}</span>
            </div>
            <div className="kv">
              <span className="k">钱包余额（ETH）</span>
              <span className="v num">{ethBalance} ETH</span>
            </div>
            <button type="button" className="btn secondary" onClick={onDisconnect} style={{ marginTop: 8 }}>
              断开连接
            </button>
          </div>
        )}
      </section>

      <div className="assets-actions">
        <button type="button" onClick={() => openTransfer('deposit', 'USDT')}>
          <span className="assets-act-ico">↓</span>存入
        </button>
        <button type="button" onClick={() => openTransfer('withdraw', 'USDT')}>
          <span className="assets-act-ico">↑</span>提取
        </button>
        <button
          type="button"
          onClick={() => {
            const p = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('pair') : null
            goTrade(p && TRADE_PAIRS.includes(p as (typeof TRADE_PAIRS)[number]) ? p : DEFAULT_PAIR)
          }}
        >
          <span className="assets-act-ico">⇄</span>去交易
        </button>
      </div>

      {valuation && valuation.distribution.length > 0 && (
        <section className="card">
          <h3 className="card-title">持仓分布（按估值）</h3>
          <div className="assets-distbar" role="img" aria-label="持仓分布">
            {valuation.distribution.map((d, i) => (
              <span
                key={d.symbol}
                style={{ width: `${d.pct}%`, background: DIST_COLORS[i % DIST_COLORS.length] }}
              />
            ))}
          </div>
          <div>
            {valuation.distribution.map((d, i) => (
              <div key={d.symbol} className="kv">
                <span className="k">
                  <span className="weight-dot" style={{ background: DIST_COLORS[i % DIST_COLORS.length] }} />
                  {d.symbol}
                </span>
                <span className="v num">{d.pct.toFixed(1)}%</span>
              </div>
            ))}
            {valuation.unpricedHeld.length > 0 && (
              <div className="kv">
                <span className="k">{valuation.unpricedHeld.join(' · ')}</span>
                <span className="v assets-dim">暂无参考价，未计入</span>
              </div>
            )}
          </div>
        </section>
      )}

      {account && onOpenBridge && (
        <button type="button" className="assets-queryrow" onClick={onOpenBridge} style={{ marginBottom: 12 }}>
          跨链交付设置：默认通道 {deliverySummary} <span aria-hidden="true">›</span>
        </button>
      )}

      <section className="card assets-balances">
        <h3 className="card-title">余额</h3>
        {balances === null ? (
          <p className="assets-dim">余额加载中…（或读取失败，稍后刷新重试）</p>
        ) : visibleRows.length === 0 ? (
          <p className="assets-dim">暂无余额。先从下方「存入」把代币存进 Vault，即可开始下单。</p>
        ) : (
          visibleRows.map((r) => {
            const meta = tokenMeta(r.symbol)
            const pair = pairForToken(r.symbol)
            return (
              <div key={r.symbol} className="assets-brow">
                <span className="markets-ico" style={{ background: meta.bg, color: meta.fg }} aria-hidden="true">
                  {meta.glyph}
                </span>
                <span className="assets-bmain">
                  <b>
                    {r.symbol} <small>{meta.name}</small>
                  </b>
                  <span className="assets-bsub num">
                    Vault 可用 {fmtQty(r.vaultAvailable)} · 锁定中 {fmtQty(r.vaultLocked)} · 钱包 {fmtQty(r.wallet)}
                    {(() => {
                      const inf = inFlightByAsset.get(r.symbol)
                      return inf ? ` · 其中交付在途 ${formatTokenAmount(inf.wei)}（经${inf.channelName}送往${inf.homeName}，未到账前不可用）` : ''
                    })()}
                  </span>
                </span>
                <span className="assets-bright">
                  <span className="num">{fmtQty(r.wallet + r.vaultTotal)}</span>
                  <small className="num">
                    {r.valueUsd !== null ? `≈ ${fmtUsd(r.valueUsd)} USDT` : '暂无参考价'}
                  </small>
                  <span className="assets-bbtns">
                    {pair && r.symbol !== 'USDT' && (
                      <button type="button" onClick={() => goTrade(pair)}>
                        交易
                      </button>
                    )}
                    <button type="button" onClick={() => openTransfer('deposit', r.symbol)}>
                      存入
                    </button>
                    <button type="button" onClick={() => openTransfer('withdraw', r.symbol)}>
                      提取
                    </button>
                  </span>
                </span>
              </div>
            )
          })
        )}
        <button type="button" className="assets-queryrow" onClick={() => setView('query')}>
          查询其他代币余额 <span aria-hidden="true">›</span>
        </button>
      </section>
    </div>
  )
}

/* ---------------- 存入 / 提取子视图（逻辑与文案沿用原资产页） ---------------- */

function TransferView({
  mode,
  symbol,
  symbols,
  chainConfig,
  account,
  balances,
  onBack,
  onDone,
}: {
  mode: 'deposit' | 'withdraw'
  symbol: string
  symbols: string[]
  chainConfig: ChainConfig | null
  account: string
  balances: TokenBalance[] | null
  onBack: () => void
  onDone: () => void
}) {
  const [sym, setSym] = useState(symbol)
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const row = balances?.find((b) => b.symbol === sym) ?? null
  const isDeposit = mode === 'deposit'

  const handleMax = () => {
    if (!row) return
    setAmount(String(isDeposit ? row.wallet : row.vaultAvailable))
  }

  const handleSubmit = useCallback(async () => {
    if (!chainConfig) return
    const tokenAddr = chainConfig.tokens?.[sym]
    if (!tokenAddr) {
      setError('该代币未在当前链登记')
      return
    }
    const amountWei = parseAmountInput(amount)
    if (amountWei === 0n) {
      setError(isDeposit ? '请输入存入数量' : '请输入提取数量')
      return
    }
    setError(null)
    setDone(false)
    setBusy(true)
    try {
      await withSigner(async (signer) => {
        const vault = new Contract(chainConfig.contracts.vault, VAULT_ABI, signer)
        if (isDeposit) {
          const token = new Contract(tokenAddr, ERC20_ABI, signer)
          await ensureAllowance(token, account, chainConfig.contracts.vault, amountWei)
          await (await vault.deposit(tokenAddr, amountWei)).wait()
        } else {
          const provider = getProvider()
          if (provider) {
            const vaultRead = new Contract(chainConfig.contracts.vault, VAULT_ABI, provider)
            const avail = (await vaultRead.availableBalance(account, tokenAddr).catch(() => null)) as bigint | null
            if (avail !== null && amountWei > avail) {
              throw new Error(
                `提取数量超过可用余额：可用 ${formatTokenAmount(avail)}。挂单锁定的部分不能提取，先撤单释放后再提取。`,
              )
            }
          }
          await (await vault.withdraw(tokenAddr, amountWei)).wait()
        }
      })
      setAmount('')
      setDone(true)
      onDone()
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }, [chainConfig, sym, amount, account, isDeposit, onDone])

  return (
    <>
      <div className="subbar">
        <button type="button" onClick={onBack} aria-label="返回资产总览">
          ‹
        </button>
        <span className="subbar-title">{isDeposit ? '存入' : '提取'}</span>
      </div>
      <section className="card">
        <label className="assets-field-label">代币</label>
        <div className="assets-tokenrow">
          <span className="markets-ico" style={{ background: tokenMeta(sym).bg, color: tokenMeta(sym).fg }} aria-hidden="true">
            {tokenMeta(sym).glyph}
          </span>
          <Select
            value={sym}
            onChange={(v) => v && setSym(v)}
            data={symbols.map((s) => ({ value: s, label: `${s} · ${tokenMeta(s).name}` }))}
            aria-label="选择代币"
            style={{ flex: 1 }}
          />
        </div>
        <label className="assets-field-label" htmlFor="transfer-amount">
          数量
        </label>
        <div className="assets-amountrow">
          <input
            id="transfer-amount"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <span className="assets-amount-unit">{sym}</span>
          <button type="button" className="ticket-max" onClick={handleMax}>
            最大
          </button>
        </div>
        <div>
          <div className="kv">
            <span className="k">钱包余额</span>
            <span className="v num">{row ? `${fmtQty(row.wallet)} ${sym}` : '—'}</span>
          </div>
          <div className="kv">
            <span className="k">Vault 可用</span>
            <span className="v num">{row ? `${fmtQty(row.vaultAvailable)} ${sym}` : '—'}</span>
          </div>
          <div className="kv">
            <span className="k">锁定中（挂单占用）</span>
            <span className="v num">{row ? `${fmtQty(row.vaultLocked)} ${sym}` : '—'}</span>
          </div>
        </div>
        <p className="hint">
          {isDeposit
            ? '步骤：填入数量后点「存入」，在钱包中确认即可。首次存入需确认两次：代币授权与存入，之后可直接存入。注意：存入是链上交易，由你自己在钱包中确认（与下单、撤单只需签名不同）；存入完成后，Vault 余额即可用于下单。'
            : '将 Vault 余额提取回钱包：填入数量后点「提取」并在钱包中确认。只能提取「可用」部分：挂单会锁定对应余额（下单时锁定，成交时按成交量消耗，撤单或到期后释放未成交部分），锁定中的部分提不出来；想提取被锁定的部分，先到「交易」页撤掉对应挂单，释放后再提取。'}
        </p>
        {error && (
          <p className="assets-error" role="alert">
            {error}
          </p>
        )}
        {done && <p className="assets-done">{isDeposit ? '存入已上链完成，余额已刷新。' : '提取已上链完成，余额已刷新。'}</p>}
        <button
          type="button"
          className={isDeposit ? 'btn primary assets-submit' : 'btn assets-submit assets-submit-dark'}
          onClick={handleSubmit}
          disabled={busy || !amount.trim()}
        >
          {busy ? '处理中…' : isDeposit ? '存入' : '提取'}
        </button>
      </section>
    </>
  )
}

/* ---------------- 查询其他代币余额子视图（原任意地址查询，原样搬入） ---------------- */

function QueryTokenView({
  chainConfig,
  account,
  onBack,
}: {
  chainConfig: ChainConfig | null
  account: string
  onBack: () => void
}) {
  const [address, setAddress] = useState<string>(() => {
    try {
      return localStorage.getItem('p2p_tokenAddress') ?? ''
    } catch {
      return ''
    }
  })
  const [result, setResult] = useState<{ wallet: string; total: string; avail: string; locked: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem('p2p_tokenAddress', address)
    } catch {
      // 存储不可用不影响查询本身
    }
  }, [address])

  const handleQuery = useCallback(async () => {
    const addr = address.trim()
    if (!chainConfig || !isValidAddress(addr)) {
      setError('请先输入有效的代币地址')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const provider = new JsonRpcProvider(chainConfig.rpcUrl)
      const vault = new Contract(chainConfig.contracts.vault, VAULT_ABI, provider)
      const token = new Contract(addr, ERC20_ABI, provider)
      const [total, w] = await Promise.all([
        vault.balanceOf(addr, account) as Promise<bigint>,
        token.balanceOf(account) as Promise<bigint>,
      ])
      const [locked, avail] = await Promise.all([
        vault.locked(account, addr).catch(() => 0n) as Promise<bigint>,
        vault.availableBalance(account, addr).catch(() => total) as Promise<bigint>,
      ])
      setResult({
        wallet: formatTokenAmount(w),
        total: formatTokenAmount(total),
        avail: formatTokenAmount(avail),
        locked: formatTokenAmount(locked),
      })
    } catch (e) {
      setResult(null)
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }, [address, chainConfig, account])

  return (
    <>
      <div className="subbar">
        <button type="button" onClick={onBack} aria-label="返回资产总览">
          ‹
        </button>
        <span className="subbar-title">查询其他代币余额</span>
      </div>
      <section className="card">
        <p className="hint">
          输入任意 ERC20 代币合约地址，查询它在你钱包与 Vault
          中的余额。所填地址保存在本机浏览器，刷新后仍会保留。查询结果只用于查看，不计入总估值。
        </p>
        <div className="input-row">
          <input
            type="text"
            placeholder="0x..."
            value={address}
            onChange={(e) => {
              setAddress(e.target.value)
              setResult(null)
            }}
            className="input"
            aria-label="代币合约地址"
          />
        </div>
        <div className="quick-tokens">
          <button
            type="button"
            className="btn-quick"
            onClick={() => chainConfig && setAddress(chainConfig.contracts.token0)}
          >
            TKA
          </button>
          <button
            type="button"
            className="btn-quick"
            onClick={() => chainConfig && setAddress(chainConfig.contracts.token1)}
          >
            TKB
          </button>
        </div>
        <button type="button" className="btn secondary" onClick={handleQuery} disabled={busy || !isValidAddress(address.trim())}>
          {busy ? '查询中…' : '查询余额'}
        </button>
        {error && (
          <p className="assets-error" role="alert">
            {error}
          </p>
        )}
        {result && !error && (
          <div style={{ marginTop: 10 }}>
            <div className="kv">
              <span className="k">钱包余额</span>
              <span className="v num">{result.wallet}</span>
            </div>
            <div className="kv">
              <span className="k">Vault 总额</span>
              <span className="v num">{result.total}</span>
            </div>
            <div className="kv">
              <span className="k">可用（可下单 / 可提取）</span>
              <span className="v num">{result.avail}</span>
            </div>
            <div className="kv">
              <span className="k">锁定中（挂单占用）</span>
              <span className="v num">{result.locked}</span>
            </div>
          </div>
        )}
      </section>
    </>
  )
}
