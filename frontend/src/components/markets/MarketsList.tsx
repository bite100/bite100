/**
 * 行情列表（第 31 轮，一组件两形态）：
 * - page 形态：「行情」一级页（搜索 / 全部·自选·持有 / 可排序列），点行 → 带交易对跳交易页；
 * - picker 形态：交易页点交易对名打开的选对页（返回头 + 点行即选中返回）。
 *
 * 价格口径（设计 §3.3 + 第 34 轮修订）：最新价 = 本所最近成交（usePairStats，
 * 与交易页同源）；无成交时价格位改显 Chainlink 参考价并标注「参考价」（明确不是
 * 成交价），参考价也取不到才显示「暂无成交」；涨跌块无成交灰显「--」、成交额
 * 占位「—」不变。有成交行价格下方 $ 小字仍是 Chainlink 参考价，口径一致。
 */
import { useEffect, useMemo, useState } from 'react'
import { Contract, JsonRpcProvider } from 'ethers'
import { useLocalStorage } from '@mantine/hooks'
import { TRADE_PAIRS } from '../../config/pairs'
import { getChainConfig } from '../../config/chains'
import { VAULT_ABI } from '../../config'
import { usePairStats } from '../../hooks/usePairStats'
import { useReferencePrice } from '../../hooks/useReferencePrice'
import {
  filterMarketRows,
  fmtCompactAmount,
  fmtMarketPrice,
  sortMarketRows,
  tokenMeta,
  toggleFavorite,
  type MarketRowData,
  type MarketSortKey,
  type MarketTabFilter,
  type SortDir,
} from './marketsData'
import './Markets.css'

interface MarketsListProps {
  chainId: number
  account: string | null
  mode: 'page' | 'picker'
  /** page 形态：点行跳交易页；picker 形态：点行选中并返回。两者都收到交易对字符串 */
  onSelectPair: (pair: string) => void
  /** picker 形态的返回按钮 */
  onBack?: () => void
}

export function MarketsList({ chainId, account, mode, onSelectPair, onBack }: MarketsListProps) {
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<MarketTabFilter>('all')
  // 自选收藏：骑 @mantine/hooks 的 useLocalStorage（键 b100.favPairs）
  const [favorites, setFavorites] = useLocalStorage<string[]>({
    key: 'b100.favPairs',
    defaultValue: [],
  })
  const [sortKey, setSortKey] = useState<MarketSortKey>('volume')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [vaultBalances, setVaultBalances] = useState<Record<string, bigint> | null>(null)

  // 「持有」口径：当前链 Vault 中任一侧代币余额 > 0。未连接钱包时该页签为空并给说明。
  useEffect(() => {
    if (!account) {
      setVaultBalances(null)
      return
    }
    const cfg = getChainConfig(chainId)
    if (!cfg) return
    let cancelled = false
    ;(async () => {
      try {
        const provider = new JsonRpcProvider(cfg.rpcUrl)
        const vault = new Contract(cfg.contracts.vault, VAULT_ABI, provider)
        const symbols = [...new Set(TRADE_PAIRS.flatMap((p) => p.split('/')))]
        const entries = await Promise.all(
          symbols.map(async (sym) => {
            const addr = cfg.tokens ? cfg.tokens[sym] : undefined
            if (!addr) return [sym, 0n] as const
            const bal = (await vault.balanceOf(addr, account)) as bigint
            return [sym, bal] as const
          }),
        )
        if (!cancelled) setVaultBalances(Object.fromEntries(entries))
      } catch {
        if (!cancelled) setVaultBalances(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [account, chainId])

  const heldPairs = useMemo(() => {
    if (!vaultBalances) return new Set<string>()
    return new Set(
      TRADE_PAIRS.filter((pair) => {
        const parts = pair.split('/')
        const b = vaultBalances[parts[0]] ?? 0n
        const q = vaultBalances[parts[1]] ?? 0n
        return b > 0n || q > 0n
      }),
    )
  }, [vaultBalances])

  const favSet = useMemo(() => new Set(favorites), [favorites])

  const handleToggleFav = (pair: string) => {
    setFavorites((prev) => toggleFavorite(prev, pair))
  }

  const handleSort = (key: MarketSortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const sortMark = (key: MarketSortKey) =>
    sortKey === key ? (sortDir === 'desc' ? '↓' : '↑') : '⇅'

  return (
    <div className="markets">
      {mode === 'picker' && (
        <div className="markets-picker-head">
          <button type="button" className="markets-back" onClick={onBack} aria-label="返回交易页">
            ‹
          </button>
          <span className="markets-picker-title">选择交易对</span>
        </div>
      )}
      <label className="markets-search">
        <span aria-hidden="true">⌕</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索币种 / 交易对"
          aria-label="搜索币种或交易对"
        />
      </label>
      <div className="text-tabs markets-tabs" role="tablist" aria-label="行情筛选">
        {(
          [
            ['all', '全部'],
            ['fav', '自选'],
            ['held', '持有'],
          ] as [MarketTabFilter, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'on' : undefined}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="markets-sortrow">
        <button type="button" className="markets-sort" onClick={() => handleSort('volume')}>
          名称 / 成交额 <span aria-hidden="true">{sortMark('volume')}</span>
        </button>
        <span className="markets-sort-spacer" />
        <button type="button" className="markets-sort" onClick={() => handleSort('price')}>
          最新价 <span aria-hidden="true">{sortMark('price')}</span>
        </button>
        <button type="button" className="markets-sort" onClick={() => handleSort('change')}>
          24h 涨跌 <span aria-hidden="true">{sortMark('change')}</span>
        </button>
      </div>
      <MarketRows
        chainId={chainId}
        query={query}
        tab={tab}
        favorites={favSet}
        heldPairs={heldPairs}
        account={account}
        sortKey={sortKey}
        sortDir={sortDir}
        onToggleFav={handleToggleFav}
        onSelectPair={onSelectPair}
      />
      {tab === 'held' && !account && (
        <p className="markets-note">「持有」按你 Vault 里的余额筛选，连接钱包后可用。</p>
      )}
      {tab === 'fav' && favorites.length === 0 && (
        <p className="markets-note">还没有自选，点任意一行右侧的 ☆ 即可收藏。</p>
      )}
      <p className="markets-note">
        最新价与 24 小时涨跌只按本站成交计算；没有成交过的交易对，价格位会显示 Chainlink
        参考价并标注「参考价」，参考价也取不到时才显示「暂无成交」。有成交时价格下方 $ 数字同样是 Chainlink
        参考价（美元），仅供参考，不是本站成交价。
      </p>
    </div>
  )
}

/**
 * 行情行价格格（三态，第 34 轮抽出以便单测）：
 * - 有成交：主价 = 本所最近成交价；Chainlink 参考价以 $ 小字附在下方；
 * - 无成交但有参考价：价格位显示参考价（$ 口径与小字一致）并标注「参考价」，
 *   明确不是成交价（成交额与涨跌仍为占位）；
 * - 无成交且无参考价：显示「暂无成交」。
 */
export function MarketPriceCell({
  lastPrice,
  refUsd,
}: {
  lastPrice: number | null
  refUsd: number | null
}) {
  if (lastPrice !== null) {
    return (
      <span className="markets-price">
        <span className="num">{fmtMarketPrice(lastPrice)}</span>
        {refUsd !== null && <span className="markets-ref num">${fmtMarketPrice(refUsd)}</span>}
      </span>
    )
  }
  if (refUsd !== null) {
    return (
      <span className="markets-price">
        <span className="num">${fmtMarketPrice(refUsd)}</span>
        <span className="markets-reftag">参考价</span>
      </span>
    )
  }
  return (
    <span className="markets-price">
      <span className="markets-notrade">暂无成交</span>
    </span>
  )
}

/**
 * 行数据层：每行是一个子组件（各自调用 usePairStats / useReferencePrice）。
 * 筛选与排序需要全部行的数据，因此先由 RowCollector 汇总成 MarketRowData，
 * 再经纯函数筛选/排序后渲染——行组件本身只取数，不渲染 DOM。
 */
function MarketRows(props: {
  chainId: number
  query: string
  tab: MarketTabFilter
  favorites: ReadonlySet<string>
  heldPairs: ReadonlySet<string>
  account: string | null
  sortKey: MarketSortKey
  sortDir: SortDir
  onToggleFav: (pair: string) => void
  onSelectPair: (pair: string) => void
}) {
  const [collected, setCollected] = useState<Record<string, MarketRowData>>({})

  const rows = useMemo(() => {
    const all = TRADE_PAIRS.map((pair) => {
      const c = collected[pair]
      const parts = pair.split('/')
      return {
        pair,
        base: parts[0],
        quote: parts[1],
        lastPrice: c ? c.lastPrice : null,
        changePct: c ? c.changePct : null,
        volumeQuote: c ? c.volumeQuote : null,
        refUsd: c ? c.refUsd : null,
        held: props.heldPairs.has(pair),
      } satisfies MarketRowData
    })
    return sortMarketRows(filterMarketRows(all, props.query, props.tab, props.favorites), props.sortKey, props.sortDir)
  }, [collected, props.query, props.tab, props.favorites, props.sortKey, props.sortDir, props.heldPairs])

  return (
    <div className="markets-list">
      {TRADE_PAIRS.map((pair) => (
        <RowCollector
          key={`${props.chainId}-${pair}`}
          pair={pair}
          onData={(d) =>
            setCollected((prev) => (sameRow(prev[pair], d) ? prev : { ...prev, [pair]: d }))
          }
        />
      ))}
      {rows.length === 0 && <p className="markets-empty">没有符合条件的交易对。</p>}
      {rows.map((r) => {
        const meta = tokenMeta(r.base)
        const isFav = props.favorites.has(r.pair)
        return (
          <div key={r.pair} className="markets-row" onClick={() => props.onSelectPair(r.pair)}>
            <span className="markets-ico" style={{ background: meta.bg, color: meta.fg }} aria-hidden="true">
              {meta.glyph}
            </span>
            <span className="markets-main">
              <span className="markets-pairline">
                <b>{r.pair}</b>
                <span className="pill pill-spot">现货</span>
                <button
                  type="button"
                  className={isFav ? 'markets-star on' : 'markets-star'}
                  aria-label={isFav ? `取消收藏 ${r.pair}` : `收藏 ${r.pair}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onToggleFav(r.pair)
                  }}
                >
                  {isFav ? '★' : '☆'}
                </button>
              </span>
              <span className="markets-sub">
                {meta.name} · 成交额 {r.volumeQuote !== null ? fmtCompactAmount(r.volumeQuote) : '—'}
              </span>
            </span>
            <MarketPriceCell lastPrice={r.lastPrice} refUsd={r.refUsd} />
            <span
              className={
                'markets-chg num ' +
                (r.changePct === null ? 'flat' : r.changePct >= 0 ? 'up' : 'down')
              }
            >
              {r.changePct === null ? '--' : `${r.changePct >= 0 ? '+' : ''}${r.changePct.toFixed(2)}%`}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function sameRow(a: MarketRowData | undefined, b: MarketRowData): boolean {
  if (!a) return false
  return (
    a.lastPrice === b.lastPrice &&
    a.changePct === b.changePct &&
    a.volumeQuote === b.volumeQuote &&
    a.refUsd === b.refUsd
  )
}

function RowCollector({
  pair,
  onData,
}: {
  pair: string
  onData: (d: MarketRowData) => void
}) {
  const stats = usePairStats(pair)
  const reference = useReferencePrice(pair, {
    lastTradePrice: stats.lastPrice,
    lastTradeAtSec: stats.lastTradeAt,
  })
  const [base, quote] = pair.split('/')
  const refUsd =
    reference.status === 'ok' && reference.ref.source === 'chainlink' ? reference.ref.price : null

  useEffect(() => {
    onData({
      pair,
      base,
      quote,
      lastPrice: stats.lastPrice,
      changePct: stats.change24hPct,
      volumeQuote: stats.volume24hQuote,
      refUsd,
      held: false,
    })
    // onData 身份由父组件内联传入，依赖只取数值字段避免循环渲染
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair, base, quote, stats.lastPrice, stats.change24hPct, stats.volume24hQuote, refUsd])
  return null
}
