/**
 * 「上架新币」页（第六十轮，用户自助上架）：任何人粘贴两个代币合约地址，
 * 即可把一个新交易对登记进中继的 pairs 注册表，登记完马上能挂单交易——
 * 不设审批、不走治理。代币元数据前端先链上直读预览（注册时中继还会再
 * 复读一次为准），参考价预览骑 DexScreener 聚合报价（查不到老实显示
 * 暂无参考价）。
 *
 * 风险披露按知情选择规则写在确认之前：任何人可上架、平台未审核不背书、
 * 冒牌币/诈骗币风险、只认合约地址不认符号。确认勾选不预选。
 * 移动优先：单列、输入与按钮触控目标 ≥44px、无页面级横向滚动。
 */
import { useMemo, useState } from 'react'
import { getChainConfig } from '../config/chains'
import {
  buildPairKey,
  fetchListedPairs,
  isAddress,
  readTokenMetadata,
  registerPairOnRelay,
  type ListedPair,
  type TokenMeta,
} from '../services/pairRegistry'
import { fetchDexPairUsdPrices } from '../services/dexReferencePrice'
import { useListedPairs } from '../hooks/useListedPairs'
import { shortAddress } from '../utils'
import './ListTokenPage.css'

interface ListTokenPageProps {
  chainId: number
  account: string | null
  /** 上架成功（或点已上架行）后跳到该交易对的交易页 */
  onGoTrade: (pair: string) => void
}

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ok'
      base: TokenMeta
      quote: TokenMeta
      refPrice: number | null
      existing: ListedPair | null
    }

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export function ListTokenPage({ chainId, account, onGoTrade }: ListTokenPageProps) {
  const chainName = getChainConfig(chainId)?.name ?? `链 ${chainId}`
  const [baseAddr, setBaseAddr] = useState('')
  const [quoteAddr, setQuoteAddr] = useState('')
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' })
  const [riskAck, setRiskAck] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState<{ pair: ListedPair; duplicate: boolean } | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const { pairs: listedPairs, refresh } = useListedPairs(chainId)

  const inputsValid = useMemo(() => {
    const b = baseAddr.trim().toLowerCase()
    const q = quoteAddr.trim().toLowerCase()
    return (
      isAddress(b) &&
      isAddress(q) &&
      b !== q &&
      b !== ZERO_ADDRESS &&
      q !== ZERO_ADDRESS
    )
  }, [baseAddr, quoteAddr])

  const inputError = useMemo(() => {
    const b = baseAddr.trim()
    const q = quoteAddr.trim()
    if (b && !isAddress(b)) return '基础币地址格式不对：应为 0x 开头的 42 位合约地址'
    if (q && !isAddress(q)) return '计价币地址格式不对：应为 0x 开头的 42 位合约地址'
    if (b && q && b.toLowerCase() === q.toLowerCase()) return '基础币和计价币不能是同一个代币'
    if (b.toLowerCase() === ZERO_ADDRESS || q.toLowerCase() === ZERO_ADDRESS) return '不能用零地址上架'
    return null
  }, [baseAddr, quoteAddr])

  const handlePreview = async () => {
    setDone(null)
    setSubmitError(null)
    setRiskAck(false)
    setPreview({ status: 'loading' })
    const b = baseAddr.trim().toLowerCase()
    const q = quoteAddr.trim().toLowerCase()
    const [base, quote] = await Promise.all([
      readTokenMetadata(chainId, b),
      readTokenMetadata(chainId, q),
    ])
    if (!base || !quote) {
      const bad = !base ? '基础币' : '计价币'
      setPreview({
        status: 'error',
        message: `${bad}地址读不到代币信息：这个地址在${chainName}上可能没有合约、不是标准 ERC-20，或者符号里带了不允许的字符（空格/斜杠/冒号）。请核对地址是不是这条链上的代币合约。`,
      })
      return
    }
    const [listed, usd] = await Promise.all([
      fetchListedPairs(chainId),
      fetchDexPairUsdPrices(chainId, b, q),
    ])
    const key = buildPairKey(chainId, b, q)
    const existing = listed.find((p) => p.pairKey === key) ?? null
    let refPrice: number | null = null
    if (usd.baseUsd !== null && usd.quoteUsd !== null && usd.quoteUsd > 0) {
      refPrice = usd.baseUsd / usd.quoteUsd
    } else if (usd.baseUsd !== null && ['USDT', 'USDC', 'DAI', 'TUSD'].includes(quote.symbol.toUpperCase())) {
      refPrice = usd.baseUsd
    }
    setPreview({ status: 'ok', base, quote, refPrice, existing })
  }

  const handleRegister = async () => {
    if (preview.status !== 'ok' || !riskAck) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const { pair, duplicate } = await registerPairOnRelay(
        chainId,
        preview.base.address,
        preview.quote.address,
        account,
      )
      setDone({ pair, duplicate })
      refresh()
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : '上架失败，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  const reset = () => {
    setBaseAddr('')
    setQuoteAddr('')
    setPreview({ status: 'idle' })
    setRiskAck(false)
    setDone(null)
    setSubmitError(null)
  }

  return (
    <div className="list-token">
      <section className="card">
        <h3 className="lt-h">这是什么</h3>
        <p className="hint">
          谁的币都能上：把两个代币的合约地址填进来，就能给它们开一个交易对，
          开完马上能在本站挂单买卖，不用申请、不用审批、不用投票。
          平台只提供订单簿和撮合，不审核、不背书任何上架的代币。
        </p>
        <p className="hint">
          <span className="lt-badge">当前链：{chainName}</span>
        </p>
      </section>

      <section className="card">
        <h3 className="lt-h">上架前先看清楚（风险提示）</h3>
        <ul className="lt-list">
          <li>
            <b>任何人都能上架，平台没有审核过。</b>
            冒牌币、诈骗币完全可能被挂上来——符号和名字都可以仿冒，
            <b>只认合约地址，不认符号</b>。地址对不上，再像的币也是假的。
          </li>
          <li>
            <b>上架错了删不掉。</b>交易对登记后会一直留在列表里，填地址前务必逐字核对。
          </li>
          <li>
            <b>价格参考不等于有人买。</b>参考价来自公开聚合报价（DexScreener），新币、测试网的币
            大多查不到报价，会老实显示「暂无参考价」；有没有人挂单、能不能成交，看订单簿说话。
          </li>
          <li>
            <b>买卖自担风险。</b>平台只做中介撮合，不为任何代币的价格、真假和项目方跑路负责。
          </li>
        </ul>
      </section>

      <section className="card">
        <h3 className="lt-h">操作步骤</h3>
        <ol className="lt-steps">
          <li>粘贴<b>基础币</b>（要买卖的币）在这条链上的合约地址；</li>
          <li>粘贴<b>计价币</b>（定价用的币，常用稳定币如 USDT）合约地址；</li>
          <li>点「读取代币信息」，核对两个币的符号、名称、小数位都对；</li>
          <li>看完风险提示、勾选确认，点「确认上架」——登记完立刻能去交易。</li>
        </ol>
        <p className="hint">
          前提：两个地址都必须是{chainName}上的 ERC-20 代币合约（普通钱包地址不行）；
          地址从代币的官方渠道复制，不要从来历不明的网页抄。
        </p>
      </section>

      <section className="card">
        <h3 className="lt-h">上架一个交易对</h3>
        {done ? (
          <div className="lt-done">
            <p className="lt-done-title">
              ✅ {done.duplicate ? '这个交易对已经上架过了' : '上架成功'}：
              {done.pair.base.symbol}/{done.pair.quote.symbol}
            </p>
            <p className="hint">
              {done.pair.base.symbol} 合约 {done.pair.base.address}（{done.pair.base.decimals} 位小数）；
              {done.pair.quote.symbol} 合约 {done.pair.quote.address}（{done.pair.quote.decimals} 位小数）。
              现在就可以去这个交易对挂单交易了。下单前先到「资产」把要用的币存入 Vault。
            </p>
            <div className="lt-actions">
              <button type="button" className="btn primary lt-btn" onClick={() => onGoTrade(done.pair.pairKey)}>
                去交易 {done.pair.base.symbol}/{done.pair.quote.symbol}
              </button>
              <button type="button" className="btn secondary lt-btn" onClick={reset}>
                再上架一个
              </button>
            </div>
          </div>
        ) : (
          <>
            <label className="lt-label" htmlFor="lt-base">基础币合约地址</label>
            <input
              id="lt-base"
              className="input lt-input"
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="0x…（要买卖的币）"
              value={baseAddr}
              onChange={(e) => {
                setBaseAddr(e.target.value)
                setPreview({ status: 'idle' })
              }}
            />
            <label className="lt-label" htmlFor="lt-quote">计价币合约地址</label>
            <input
              id="lt-quote"
              className="input lt-input"
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="0x…（定价用的币，如 USDT）"
              value={quoteAddr}
              onChange={(e) => {
                setQuoteAddr(e.target.value)
                setPreview({ status: 'idle' })
              }}
            />
            {inputError && <p className="lt-error">{inputError}</p>}
            <div className="lt-actions">
              <button
                type="button"
                className="btn primary lt-btn"
                disabled={!inputsValid || preview.status === 'loading'}
                onClick={handlePreview}
              >
                {preview.status === 'loading' ? '读取中…' : '读取代币信息'}
              </button>
            </div>

            {preview.status === 'error' && <p className="lt-error">{preview.message}</p>}

            {preview.status === 'ok' && (
              <div className="lt-preview">
                <div className="lt-tokenrow">
                  <span className="lt-token-sym">{preview.base.symbol}</span>
                  <span className="lt-token-meta">
                    {preview.base.name} · {preview.base.decimals} 位小数
                    <small>{preview.base.address}</small>
                  </span>
                </div>
                <div className="lt-tokenrow">
                  <span className="lt-token-sym">{preview.quote.symbol}</span>
                  <span className="lt-token-meta">
                    {preview.quote.name} · {preview.quote.decimals} 位小数
                    <small>{preview.quote.address}</small>
                  </span>
                </div>
                <p className="hint">
                  参考价预览：
                  {preview.refPrice !== null
                    ? `1 ${preview.base.symbol} ≈ ${preview.refPrice} ${preview.quote.symbol}（DexScreener 聚合报价，仅供参考，成交价以订单簿为准）`
                    : '暂无参考价（聚合报价查不到这个币——测试网的币基本都查不到，这是正常情况，不影响上架和挂单；交易页会用本所成交/盘口价格兜底，都没有时显示暂无参考价）'}
                </p>
                {preview.existing ? (
                  <>
                    <p className="hint">这个交易对已经在列表里了，不用重复上架，直接去交易就行。</p>
                    <div className="lt-actions">
                      <button
                        type="button"
                        className="btn primary lt-btn"
                        onClick={() => onGoTrade(preview.existing!.pairKey)}
                      >
                        去交易 {preview.base.symbol}/{preview.quote.symbol}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <label className="lt-ack">
                      <input
                        type="checkbox"
                        checked={riskAck}
                        onChange={(e) => setRiskAck(e.target.checked)}
                      />
                      <span>
                        我已看懂上面的风险提示：这个交易对未经平台审核，我核对过两个合约地址无误，
                        上架后删不掉，买卖风险自己承担。
                      </span>
                    </label>
                    {submitError && <p className="lt-error">{submitError}</p>}
                    <div className="lt-actions">
                      <button
                        type="button"
                        className="btn primary lt-btn"
                        disabled={!riskAck || submitting}
                        onClick={handleRegister}
                      >
                        {submitting ? '上架中…' : `确认上架 ${preview.base.symbol}/${preview.quote.symbol}`}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </section>

      <section className="card">
        <h3 className="lt-h">本链已上架（自助）</h3>
        {listedPairs.length === 0 ? (
          <p className="hint">还没有用户自助上架的交易对（种子交易对在行情页和交易对选择器里）。</p>
        ) : (
          <div className="lt-listed">
            {listedPairs.map((p) => (
              <div key={p.pairKey} className="lt-listed-row">
                <span className="lt-listed-main">
                  <b>
                    {p.base.symbol}/{p.quote.symbol}
                  </b>
                  <span className="pill">自助上架</span>
                  <small>
                    {p.base.symbol} {shortAddress(p.base.address)} · {p.quote.symbol}{' '}
                    {shortAddress(p.quote.address)}
                  </small>
                </span>
                <button type="button" className="btn secondary lt-btn lt-go" onClick={() => onGoTrade(p.pairKey)}>
                  去交易
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
