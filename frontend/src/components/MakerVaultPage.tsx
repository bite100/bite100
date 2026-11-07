/**
 * 做市金库子页（第 31 轮 §12.1 定稿蓝图）：资产页「金库」页签。
 * 全部数字读第 30 轮现行 MakerVault 合约（链上），读不到不显示数字；
 * 存入 = USDT approve + ERC-4626 deposit，提取 = redeem 份额（真实接线）。
 * NAV 快照线为本机采样（打开本页时记录），采样不足整行隐藏，不编造历史。
 */
import { useCallback, useEffect, useState } from 'react'
import { Contract, JsonRpcProvider, formatUnits } from 'ethers'
import type { ChainConfig } from '../config/chains'
import { ERC20_ABI } from '../config'
import { withSigner, formatError } from '../utils'
import {
  MAKERVAULT_ABI,
  loadNavSamples,
  recordNavSample,
  type MakerVaultData,
  type NavSample,
} from './assets/makerVaultData'
import { estimateQuoteForShares, estimateSharesForDeposit } from './assets/makerVaultMath'
import { ensureAllowance, parseAmountInput } from './assets/tokenOps'
import './MakerVaultPage.css'

interface MakerVaultPageProps {
  chainConfig: ChainConfig | null
  account: string
  data: MakerVaultData | null
  loading: boolean
  failed: boolean
  onChanged: () => void
}

const fmtN = (n: number, digits = 2): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const fmtNav = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 })

export function MakerVaultPage({ chainConfig, account, data, loading, failed, onChanged }: MakerVaultPageProps) {
  const [samples, setSamples] = useState<NavSample[]>([])
  const [walletQuote, setWalletQuote] = useState<number | null>(null)
  const [depositAmount, setDepositAmount] = useState('')
  const [redeemShares, setRedeemShares] = useState('')
  const [busy, setBusy] = useState<'deposit' | 'redeem' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const mvAddress = chainConfig?.contracts.makerVault
  const assetSymbol = data?.assetSymbol ?? 'USDT'
  const assetAddress = chainConfig?.tokens?.[assetSymbol]

  /* NAV 采样：每次拿到链上读数记一点（本机保存，口径见页内注） */
  useEffect(() => {
    if (!data || !chainConfig || !mvAddress) return
    setSamples(recordNavSample(chainConfig.chainId, mvAddress, data.derived.nav, Date.now()))
  }, [data, chainConfig, mvAddress])

  useEffect(() => {
    if (chainConfig && mvAddress) {
      setSamples(loadNavSamples(chainConfig.chainId, mvAddress))
    }
  }, [chainConfig, mvAddress])

  /* 钱包计价余额（存入区「钱包余额」行） */
  useEffect(() => {
    if (!chainConfig || !assetAddress) {
      setWalletQuote(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const provider = new JsonRpcProvider(chainConfig.rpcUrl)
        const token = new Contract(assetAddress, ERC20_ABI, provider)
        const bal = (await token.balanceOf(account)) as bigint
        if (!cancelled) setWalletQuote(Number(formatUnits(bal, 18)))
      } catch {
        if (!cancelled) setWalletQuote(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [chainConfig, assetAddress, account, data])

  const handleDeposit = useCallback(async () => {
    if (!chainConfig || !mvAddress || !assetAddress) return
    const amountWei = parseAmountInput(depositAmount)
    if (amountWei === 0n) {
      setError('请输入存入数量')
      return
    }
    setError(null)
    setDone(null)
    setBusy('deposit')
    try {
      await withSigner(async (signer) => {
        const token = new Contract(assetAddress, ERC20_ABI, signer)
        const mv = new Contract(mvAddress, MAKERVAULT_ABI, signer)
        await ensureAllowance(token, account, mvAddress, amountWei)
        await (await mv.deposit(amountWei, account)).wait()
      })
      setDepositAmount('')
      setDone('存入已上链完成，份额已按最新读数刷新。')
      onChanged()
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(null)
    }
  }, [chainConfig, mvAddress, assetAddress, depositAmount, account, onChanged])

  const handleRedeem = useCallback(async () => {
    if (!chainConfig || !mvAddress) return
    const sharesWei = parseAmountInput(redeemShares)
    if (sharesWei === 0n) {
      setError('请输入赎回份额')
      return
    }
    setError(null)
    setDone(null)
    setBusy('redeem')
    try {
      await withSigner(async (signer) => {
        const mv = new Contract(mvAddress, MAKERVAULT_ABI, signer)
        await (await mv.redeem(sharesWei, account, account)).wait()
      })
      setRedeemShares('')
      setDone('提取已上链完成，USDT 已回到你的钱包。')
      onChanged()
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(null)
    }
  }, [chainConfig, mvAddress, redeemShares, account, onChanged])

  if (!mvAddress) {
    return (
      <section className="card">
        <p className="hint">当前网络尚未部署做市金库，暂无金库可进入。</p>
      </section>
    )
  }

  const depNum = parseFloat(depositAmount) || 0
  const redNum = parseFloat(redeemShares) || 0
  const estShares = data ? estimateSharesForDeposit(depNum, data.totalAssets, data.totalShares) : 0
  const estQuote = data ? estimateQuoteForShares(redNum, data.totalAssets, data.totalShares) : 0
  const spark = samples.slice(-60)

  return (
    <div className="mv-page">
      <section className="card">
        <span className="pill pill-accent">做市金库 · MAKERVAULT（ERC-4626）</span>
        <div className="mv-total-label">金库总规模（Total Assets）</div>
        {data ? (
          <div className="mv-total num">
            {fmtN(data.totalAssets)} <small>{assetSymbol}</small>
          </div>
        ) : (
          <p className="hint" style={{ marginTop: 8 }}>
            {loading ? '金库读数加载中…' : '金库读数暂时不可用（喂价过期时合约会拒绝给出总资产，属预期行为），数字不展示。'}
          </p>
        )}
        {data && spark.length >= 2 && (
          <>
            <div className="mv-snap-row">
              <span>NAV 快照 · 近 30 日</span>
              <span className="num">
                现值 <b>{fmtNav(data.derived.nav)}</b>
              </span>
            </div>
            <NavSparkline samples={spark} />
          </>
        )}
        <p className="mv-note">
          快照线由本机在你打开本页时按链上 NAV 采样绘制（保存在本机浏览器），不是链上历史数据；采样点不足时整行不展示。
        </p>
      </section>

      <section className="card">
        <h3 className="card-title">金库明细</h3>
        {data ? (
          <div>
            <div className="kv">
              <span className="k">份额净值 NAV（每份可赎回）</span>
              <span className="v num">{fmtNav(data.derived.nav)} {assetSymbol}</span>
            </div>
            <div className="kv">
              <span className="k">总份额</span>
              <span className="v num">{fmtN(data.totalShares)}</span>
            </div>
            <div className="kv">
              <span className="k">我的份额</span>
              <span className="v num">{fmtN(data.myShares)}</span>
            </div>
            <div className="kv">
              <span className="k">我的市值（份额 × NAV）</span>
              <span className="v num">{fmtN(data.derived.myValue)} {assetSymbol}</span>
            </div>
            <div className="kv">
              <span className="k">我的可提份额（未被挂单锁定）</span>
              <span className="v num">{fmtN(data.derived.redeemableShares)}</span>
            </div>
            <div className="kv">
              <span className="k">做市挂单占用中（对应份额）</span>
              <span className="v num">{fmtN(data.derived.lockedShares)}</span>
            </div>
          </div>
        ) : (
          <p className="hint">{failed ? '链上读数失败，明细暂不展示。' : '加载中…'}</p>
        )}
        <p className="mv-note">
          本页数字全部读取金库合约的链上数据（净值、总份额、总规模、我的份额），读不到时不展示数字。
        </p>
      </section>

      {error && (
        <p className="assets-error" role="alert">
          {error}
        </p>
      )}
      {done && <p className="assets-done">{done}</p>}

      <section className="card">
        <h3 className="card-title">存入 {assetSymbol}，换取份额</h3>
        <label className="assets-field-label" htmlFor="mv-deposit-amount">
          存入数量
        </label>
        <div className="assets-amountrow">
          <input
            id="mv-deposit-amount"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={depositAmount}
            onChange={(e) => setDepositAmount(e.target.value)}
          />
          <span className="assets-amount-unit">{assetSymbol}</span>
          <button
            type="button"
            className="ticket-max"
            onClick={() => walletQuote !== null && setDepositAmount(String(walletQuote))}
          >
            最大
          </button>
        </div>
        <div>
          <div className="kv">
            <span className="k">钱包余额</span>
            <span className="v num">{walletQuote !== null ? `${fmtN(walletQuote)} ${assetSymbol}` : '—'}</span>
          </div>
          <div className="kv">
            <span className="k">预计获得份额{data ? `（按 NAV ${fmtNav(data.derived.nav)} 折算）` : ''}</span>
            <span className="v num">{data && depNum > 0 ? `≈ ${fmtN(estShares)} 份` : '—'}</span>
          </div>
        </div>
        <p className="hint">
          存入的是你钱包里的 {assetSymbol}，换得的份额可以在下方随时赎回。首次存入需先在钱包里确认一次{' '}
          {assetSymbol} 授权，之后可直接存入；存入本身是链上交易，在钱包中确认。
        </p>
        {data?.paused && <p className="mv-paused">金库当前已暂停：存入不可用（提取不受影响）。</p>}
        <button
          type="button"
          className="btn primary assets-submit"
          onClick={handleDeposit}
          disabled={busy !== null || !depositAmount.trim() || data?.paused}
        >
          {busy === 'deposit' ? '处理中…' : '存入'}
        </button>
      </section>

      <section className="card">
        <h3 className="card-title">提取（赎回份额）</h3>
        <label className="assets-field-label" htmlFor="mv-redeem-shares">
          赎回份额
        </label>
        <div className="assets-amountrow">
          <input
            id="mv-redeem-shares"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={redeemShares}
            onChange={(e) => setRedeemShares(e.target.value)}
          />
          <span className="assets-amount-unit">份</span>
          <button
            type="button"
            className="ticket-max"
            onClick={() => data && setRedeemShares(String(data.derived.redeemableShares))}
          >
            最大
          </button>
        </div>
        <div>
          <div className="kv">
            <span className="k">我的可提份额</span>
            <span className="v num">{data ? `${fmtN(data.derived.redeemableShares)} 份` : '—'}</span>
          </div>
          <div className="kv">
            <span className="k">预计赎回{data ? `（按 NAV ${fmtNav(data.derived.nav)} 折算）` : ''}</span>
            <span className="v num">{data && redNum > 0 ? `≈ ${fmtN(estQuote)} ${assetSymbol}` : '—'}</span>
          </div>
        </div>
        <p className="hint">
          提取按份额赎回成 {assetSymbol}{' '}
          回到你的钱包。挂单锁定的部分不能提取（金库正在用这部分资金挂单做市），需要等挂单成交或撤单、锁定释放后再提；金库暂停时仍可提取。
        </p>
        <button
          type="button"
          className="btn assets-submit assets-submit-dark"
          onClick={handleRedeem}
          disabled={busy !== null || !redeemShares.trim()}
        >
          {busy === 'redeem' ? '处理中…' : '提取'}
        </button>
      </section>

      <section className="card">
        <h3 className="card-title">份额与 NAV 说明</h3>
        <div className="mv-explain">
          <div>
            <b>份额是什么</b>
            <p>ERC-4626 份额凭证。存入时按当时 NAV 折算份额，提取时按当时 NAV 赎回 {assetSymbol}，份额本身不单独交易。</p>
          </div>
          <div>
            <b>NAV 怎么变</b>
            <p>NAV = 金库全部资产净值 ÷ 总份额。做市收益留在金库里、体现在 NAV 上涨，不单独分红；做市亏损同样体现在 NAV 下跌。</p>
          </div>
          <div>
            <b>谁在做市</b>
            <p>金库登记的专用签名者自动挂单做市。签名者只能签名交易、不能提款；签名者可以更换，金库暂停时停止做市与存入，提取与更换签名者不受影响。</p>
          </div>
          <div>
            <b>数据口径</b>
            <p>本页所有数字读自金库合约（链上），页面不估算、不补数；链上读不到时该数字不展示。</p>
          </div>
        </div>
      </section>
    </div>
  )
}

function NavSparkline({ samples }: { samples: NavSample[] }) {
  const values = samples.map((s) => s.nav)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * 300).toFixed(1)},${(34 - ((v - min) / range) * 30).toFixed(1)}`)
    .join(' ')
  return (
    <svg className="mv-spark" viewBox="0 0 300 38" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke="var(--b100-accent)" strokeWidth="1.8" />
    </svg>
  )
}
