import { useCallback, useEffect, useState } from 'react'
import { Tabs, Text, Button } from '@mantine/core'
import { Contract } from 'ethers'
import { nodeGet, nodePost } from '../../nodeClient'
import { signCancelOrder } from '../../services/orderSigning'
import { formatError, formatTokenAmount, getProvider } from '../../utils'
import { ERC20_ABI, VAULT_ABI, VAULT_ADDRESS, CHAIN_ID } from '../../config'
import { INDEXER_ENABLED } from '../../config/indexer'
import { DEFAULT_PAIR, getPairTokens } from '../../config/pairs'
import {
  fetchIndexerTrades,
  loadDualTrades,
  normalizeNodeTradeRow,
  type MergedTrade,
} from '../../services/tradesDual'
import { fromScaled, fmtPrice, fmtAmount, fmtDateTime } from './tradeFormat'
import { DeliveryRecords } from '../bridge/DeliveryRecords'
import type { Order, Trade } from '../../OrderBookSection'
import type { Signer } from 'ethers'

const POLL_MS = 15000

const STATUS_LABEL: Record<string, string> = {
  open: '挂单中',
  partial: '部分成交',
  filled: '已成交',
  cancelled: '已撤销',
  canceled: '已撤销',
  expired: '已过期',
  settled: '已结算',
}

export interface TradeTabsPanelProps {
  /** 第二十五轮：当前交易对（由交易台传入，随 URL ?pair= 切换） */
  pair?: string
  account: string | null
  getSigner: () => Promise<Signer | null>
  /** 下单成功后递增，触发挂单列表刷新 */
  refreshSignal?: number
  /**
   * 变体（第 31 轮）：full = 桌面四页签（当前挂单/历史订单/成交记录/余额，缺省不变）；
   * mobile = 移动交易页三页签（当前委托/历史订单/持有币种），成交记录在图表展开态的
   * 「最新成交」里与桌面端继续提供。数据管道两变体完全共用。
   */
  variant?: 'full' | 'mobile'
}

/**
 * 第 28 轮：节点订单/成交的价格为 1e18 定点、数量为 wei，展示前统一换算
 * 并走 tradeFormat（千分位 + 量级小数位）；无法换算时原样显示。
 */
function fmtPriceCell(v: string): string {
  const n = fromScaled(v)
  return Number.isFinite(n) ? fmtPrice(n) : v
}

function fmtAmountCell(v: string): string {
  const n = fromScaled(v)
  return Number.isFinite(n) ? fmtAmount(n) : v
}

function fmtTime(sec: number): string {
  return fmtDateTime(sec)
}

interface BalanceRow {
  symbol: string
  wallet: string
  vault: string
  vaultAvailable: string
  vaultLocked: string
}

/**
 * K 线下方页签区（布局对标 Hyperliquid 底部表格区）：
 * 当前挂单 / 历史订单 / 成交记录 / 余额——实体全部来自本应用既有管道
 * （节点 /api/orders、/api/trades 与链上 ERC20/Vault 余额），无持仓/杠杆类概念。
 *
 * 第 39 轮：成交记录页签接入双源——配置 VITE_INDEXER_URL 时与右栏
 * 「最新成交」走同一条 loadDualTrades 路径（同一合并口径、单源失败
 * 降级、双源失败才报错）；未配置时仍为节点单源。展示形态与列不变，
 * 「结算」列在双源下以「待索引 / 已上链」标注来源（沿用站内口径）。
 */
export function TradeTabsPanel({ pair = DEFAULT_PAIR, account, getSigner, refreshSignal = 0, variant = 'full' }: TradeTabsPanelProps) {
  const mobile = variant === 'mobile'
  const [baseSymbol, quoteSymbol] = pair.split('/')
  const pairTokens = getPairTokens(CHAIN_ID, pair)
  const [tab, setTab] = useState<string | null>('open')
  const [myOrders, setMyOrders] = useState<Order[]>([])
  const [trades, setTrades] = useState<Trade[]>([])
  /** 第 39 轮：双源模式下的合并成交与两源失败标记（单源模式保持 null） */
  const [mergedTrades, setMergedTrades] = useState<MergedTrade[] | null>(null)
  const [tradesNodeFailed, setTradesNodeFailed] = useState(false)
  const [tradesIndexerFailed, setTradesIndexerFailed] = useState(false)
  const [balances, setBalances] = useState<BalanceRow[]>([])
  const [nodeError, setNodeError] = useState(false)
  const [tradesError, setTradesError] = useState(false)
  const [cancelLoading, setCancelLoading] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const fetchMyOrders = useCallback(async () => {
    if (!account) {
      setMyOrders([])
      return
    }
    try {
      const { data } = await nodeGet<Order[]>('/api/orders', {
        trader: account,
        pair,
        limit: '50',
      })
      setMyOrders(Array.isArray(data) ? data : [])
      setNodeError(false)
    } catch {
      setNodeError(true)
    }
  }, [account, pair])

  const fetchTrades = useCallback(async () => {
    if (INDEXER_ENABLED) {
      // 第 39 轮：与「最新成交」同一条双源路径（loadDualTrades：超时、
      // 合并、失败降级口径全共用）；双源皆失败才置 tradesError。
      try {
        const baseToken = getPairTokens(CHAIN_ID, pair)?.base ?? ''
        const outcome = await loadDualTrades(
          async (signal) => {
            const { data } = await nodeGet<unknown>(
              '/api/trades',
              { pair, limit: '30' },
              { signal },
            )
            const list = Array.isArray(data) ? data : []
            return list.map(normalizeNodeTradeRow)
          },
          (signal) => fetchIndexerTrades(CHAIN_ID, pair, 50, undefined, undefined, 0, { signal }),
          baseToken,
        )
        setMergedTrades(outcome.result.trades.filter((t) => t.price > 0).slice(0, 30))
        setTradesNodeFailed(outcome.nodeFailed)
        setTradesIndexerFailed(outcome.indexerFailed)
        setTradesError(outcome.unavailable)
      } catch {
        /* 双源路径异常兜底：保留旧数据并呈现不可用空态口径 */
        setTradesError(true)
      }
      return
    }
    try {
      const { data } = await nodeGet<Trade[]>('/api/trades', { pair, limit: '30' })
      setTrades(Array.isArray(data) ? data : [])
      setTradesError(false)
    } catch {
      /* 成交拉取失败保留旧数据；从未成功过时由 tradesError 呈现节点未连接空态 */
      setTradesError(true)
    }
  }, [pair])

  const fetchBalances = useCallback(async () => {
    if (!account) {
      setBalances([])
      return
    }
    if (!pairTokens) {
      setBalances([])
      return
    }
    try {
      const provider = getProvider()
      if (!provider) return
      const vault = new Contract(VAULT_ADDRESS, VAULT_ABI, provider)
      const rows: BalanceRow[] = []
      for (const [symbol, addr] of [
        [baseSymbol, pairTokens.base],
        [quoteSymbol, pairTokens.quote],
      ] as const) {
        const token = new Contract(addr, ERC20_ABI, provider)
        const [w, v, va, vl] = await Promise.all([
          token.balanceOf(account),
          vault.balanceOf(addr, account).catch(() => 0n),
          vault.availableBalance(account, addr).catch(() => 0n),
          vault.locked(account, addr).catch(() => 0n),
        ])
        rows.push({
          symbol,
          wallet: formatTokenAmount(w),
          vault: formatTokenAmount(v as bigint),
          vaultAvailable: formatTokenAmount(va as bigint),
          vaultLocked: formatTokenAmount(vl as bigint),
        })
      }
      setBalances(rows)
    } catch {
      setBalances([])
    }
  }, [account, pairTokens, baseSymbol, quoteSymbol])

  useEffect(() => {
    fetchMyOrders()
    fetchTrades()
    const t = setInterval(() => {
      fetchMyOrders()
      fetchTrades()
    }, POLL_MS)
    return () => clearInterval(t)
  }, [fetchMyOrders, fetchTrades, refreshSignal])

  useEffect(() => {
    fetchBalances()
  }, [fetchBalances, refreshSignal])

  const handleCancel = async (orderId: string) => {
    if (!account) return
    setCancelLoading(orderId)
    setActionError(null)
    try {
      const signer = await getSigner()
      if (!signer) throw new Error('请先连接钱包')
      const timestamp = Math.floor(Date.now() / 1000)
      const signature = await signCancelOrder(orderId, account, timestamp, signer, CHAIN_ID)
      await nodePost('/api/order/cancel', { orderId, signature, timestamp })
      await fetchMyOrders()
    } catch (e) {
      setActionError(formatError(e))
    } finally {
      setCancelLoading(null)
    }
  }

  const openOrders = myOrders.filter((o) => o.status === 'open' || o.status === 'partial')
  const sortedMine = [...myOrders].sort((a, b) => b.createdAt - a.createdAt)
  const sortedTrades = [...trades].sort((a, b) => b.timestamp - a.timestamp)

  /**
   * 第 39 轮：成交行统一视图模型——双源（MergedTrade，价格/数量已是展示
   * 数值）与节点单源（Trade，1e18 定点串走 fmtPriceCell/fmtAmountCell）
   * 收敛到同一张表渲染，列与形态不变；「结算」列双源下以待索引/已上链
   * 标注来源，单源下维持已上链/待结算口径。
   */
  const tradeRows: {
    key: string
    timestamp: number
    priceCell: string
    amountCell: string
    chipCls: string
    chipLabel: string
  }[] = INDEXER_ENABLED
    ? (mergedTrades ?? []).map((t) => ({
        key: t.key,
        timestamp: t.timestamp,
        priceCell: fmtPrice(t.price),
        amountCell: fmtAmount(t.amount),
        chipCls: t.pendingIndex ? 'status-pending' : 'status-settled',
        chipLabel: t.pendingIndex ? '待索引' : '已上链',
      }))
    : sortedTrades.slice(0, 30).map((t) => ({
        key: t.tradeId,
        timestamp: t.timestamp,
        priceCell: fmtPriceCell(t.price),
        amountCell: fmtAmountCell(t.amount),
        chipCls: t.txHash ? 'status-settled' : 'status-pending',
        chipLabel: t.txHash ? '已上链' : '待结算',
      }))

  const renderOrdersTable = (orders: Order[], withCancel: boolean) => {
    if (!account) return <Text size="sm" c="dimmed" py="sm">连接钱包后查看订单</Text>
    if (nodeError) return <Text size="sm" c="dimmed" py="sm">节点服务暂时不可用，订单无法加载（资产与跨链不受影响）</Text>
    if (orders.length === 0) return <Text size="sm" c="dimmed" py="sm">暂无订单</Text>
    return (
      <div className="trade-table-wrap">
        <table className="trade-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>方向</th>
              <th className="num">价格 ({quoteSymbol})</th>
              <th className="num">数量 ({baseSymbol})</th>
              <th className="num">已成交</th>
              <th>状态</th>
              {withCancel && <th></th>}
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.orderId}>
                <td className="time">{fmtTime(o.createdAt)}</td>
                <td className="side" style={{ color: o.side === 'buy' ? 'var(--b100-up)' : 'var(--b100-down)' }}>
                  {o.side === 'buy' ? '买入' : '卖出'}
                </td>
                <td className="num">{fmtPriceCell(o.price)}</td>
                <td className="num">{fmtAmountCell(o.amount)}</td>
                <td className="num">{fmtAmountCell(o.filled)}</td>
                <td>
                  <span className={`status-chip status-${o.status}`}>
                    {STATUS_LABEL[o.status] ?? o.status}
                  </span>
                </td>
                {withCancel && (
                  <td>
                    <Button
                      size="xs"
                      variant="subtle"
                      color="dark"
                      onClick={() => handleCancel(o.orderId)}
                      loading={cancelLoading === o.orderId}
                    >
                      撤单
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div className="trade-tabs">
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          {mobile ? (
            <>
              <Tabs.Tab value="open">当前委托{openOrders.length > 0 ? ` (${openOrders.length})` : ''}</Tabs.Tab>
              <Tabs.Tab value="history">历史订单</Tabs.Tab>
              <Tabs.Tab value="balance">持有币种</Tabs.Tab>
            </>
          ) : (
            <>
              <Tabs.Tab value="open">当前挂单{openOrders.length > 0 ? ` (${openOrders.length})` : ''}</Tabs.Tab>
              <Tabs.Tab value="history">历史订单</Tabs.Tab>
              <Tabs.Tab value="trades">成交记录</Tabs.Tab>
              <Tabs.Tab value="balance">余额</Tabs.Tab>
            </>
          )}
        </Tabs.List>

        <Tabs.Panel value="open" pt="sm">
          {actionError && (
            <Text size="sm" c="red" role="alert" mb="xs">
              {actionError}
            </Text>
          )}
          {renderOrdersTable(openOrders, true)}
          {account && openOrders.length > 0 && (
            <Text size="xs" c="dimmed" pt="xs">
              撤单只需钱包签名，不上链、不付 gas；已成交部分不受撤单影响。
            </Text>
          )}
        </Tabs.Panel>

        <Tabs.Panel value="history" pt="sm">
          {renderOrdersTable(sortedMine, false)}
        </Tabs.Panel>

        {!mobile && (
        <Tabs.Panel value="trades" pt="sm">
          {INDEXER_ENABLED && (
            <Text size="xs" c="dimmed" pb="xs">
              {tradesNodeFailed && tradesIndexerFailed
                ? '节点与链上索引均不可达，成交数据暂不可用'
                : tradesIndexerFailed
                  ? '链上索引暂不可达，暂显示节点数据（均标「待索引」）'
                  : tradesNodeFailed
                    ? '节点暂不可达，暂显示链上索引数据（Envio 为权威来源）'
                    : '来源：链上索引（Envio）为权威，节点独有成交标「待索引」'}
            </Text>
          )}
          {tradeRows.length === 0 ? (
            <Text size="sm" c="dimmed" py="sm">
              {tradesError
                ? INDEXER_ENABLED
                  ? '节点与链上索引均不可达，成交记录暂不可用（资产与跨链不受影响）'
                  : '节点服务暂时不可用，成交记录无法加载（资产与跨链不受影响）'
                : '暂无成交'}
            </Text>
          ) : (
            <div className="trade-table-wrap">
              <table className="trade-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th className="num">价格 ({quoteSymbol})</th>
                    <th className="num">数量 ({baseSymbol})</th>
                    <th>结算</th>
                  </tr>
                </thead>
                <tbody>
                  {tradeRows.map((t) => (
                    <tr key={t.key}>
                      <td className="time">{fmtTime(t.timestamp)}</td>
                      <td className="num">{t.priceCell}</td>
                      <td className="num">{t.amountCell}</td>
                      <td>
                        <span className={`status-chip ${t.chipCls}`}>{t.chipLabel}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Tabs.Panel>
        )}

        <Tabs.Panel value="balance" pt="sm">
          {!account ? (
            <Text size="sm" c="dimmed" py="sm">连接钱包后查看余额</Text>
          ) : balances.length === 0 ? (
            <Text size="sm" c="dimmed" py="sm">余额加载中…（存入与提取请前往「资产」分区）</Text>
          ) : (
            <div className="trade-table-wrap">
              <table className="trade-table">
                <thead>
                  <tr>
                    <th>资产</th>
                    <th className="num">钱包余额</th>
                    <th className="num">Vault 总额</th>
                    <th className="num">可用</th>
                    <th className="num">锁定中</th>
                  </tr>
                </thead>
                <tbody>
                  {balances.map((r) => (
                    <tr key={r.symbol}>
                      <td>{r.symbol}</td>
                      <td className="num">{r.wallet}</td>
                      <td className="num">{r.vault}</td>
                      <td className="num">{r.vaultAvailable}</td>
                      <td className="num">{r.vaultLocked}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Text size="xs" c="dimmed" mt={6}>
                「可用」= Vault 总额 − 挂单锁定；下单时按订单义务锁定，成交消耗、撤单或到期释放，锁定中的部分不能提取。
              </Text>
            </div>
          )}
        </Tabs.Panel>
      </Tabs>
      {/* 第四十一轮：跨链交付记录（设计 §4.2，挂在订单历史下方） */}
      <DeliveryRecords account={account} refreshSignal={refreshSignal} />
    </div>
  )
}
