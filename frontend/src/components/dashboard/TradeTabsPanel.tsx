import { useCallback, useEffect, useState } from 'react'
import { Tabs, Text } from '@mantine/core'
import { Contract } from 'ethers'
import { formatTokenAmount, getProvider } from '../../utils'
import { ERC20_ABI, VAULT_ABI, VAULT_ADDRESS, CHAIN_ID } from '../../config'
import { INDEXER_ENABLED } from '../../config/indexer'
import { DEFAULT_PAIR, getPairTokens } from '../../config/pairs'
import { loadIndexerTrades, type DisplayTrade } from '../../services/tradesDual'
import { fromScaled, fmtPrice, fmtAmount, fmtDateTime } from './tradeFormat'
import { DeliveryRecords } from '../bridge/DeliveryRecords'
import { HardCancelAction } from '../HardCancelAction'
import { createRelayBookAdapter } from '../../services/dualread/adapters'
import type { Order } from '../../OrderBookSection'
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
 * 中继订单的价格为 1e18 定点、数量为 wei，展示前统一换算并走
 * tradeFormat（千分位 + 量级小数位）；无法换算时原样显示。
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
 * 当前挂单 / 历史订单 / 成交记录 / 余额。
 *
 * 数据源（第 51 轮，阶段 5 节点退役后单源化）：
 * - 挂单：订单中继簿（中继只保留未成交完的挂单；第 46 轮的中继回退
 *   路径本轮转正为唯一路径，适配器缺省 fetch 自带 10 秒超时）；
 * - 成交记录：链上索引（Envio Trade 事件，与右栏「最新成交」同一条
 *   loadIndexerTrades 路径）；索引未配置/不可达时如实显示不可用；
 * - 余额：链上 ERC20/Vault 直读（不变）。
 * 撤单只剩「链上撤单」：签名撤单原本投递给节点订单簿，节点退役后无
 * 投递面（中继簿无撤单接口），按钮与说明已一并移除。
 */
export function TradeTabsPanel({ pair = DEFAULT_PAIR, account, getSigner, refreshSignal = 0, variant = 'full' }: TradeTabsPanelProps) {
  const mobile = variant === 'mobile'
  const [baseSymbol, quoteSymbol] = pair.split('/')
  const pairTokens = getPairTokens(CHAIN_ID, pair)
  const [tab, setTab] = useState<string | null>('open')
  const [myOrders, setMyOrders] = useState<Order[]>([])
  const [trades, setTrades] = useState<DisplayTrade[]>([])
  const [balances, setBalances] = useState<BalanceRow[]>([])
  const [ordersError, setOrdersError] = useState(false)
  const [tradesError, setTradesError] = useState(false)

  const fetchMyOrders = useCallback(async () => {
    if (!account) {
      setMyOrders([])
      return
    }
    try {
      const book = await createRelayBookAdapter().fetchBook(CHAIN_ID, pair)
      const mine = [...book.bids, ...book.asks].filter(
        (r) => r.trader.toLowerCase() === account.toLowerCase(),
      )
      setMyOrders(mine)
      setOrdersError(false)
    } catch {
      setOrdersError(true)
    }
  }, [account, pair])

  const fetchTrades = useCallback(async () => {
    const outcome = await loadIndexerTrades(CHAIN_ID, pair, 50)
    setTrades(outcome.trades.filter((t) => t.price > 0).slice(0, 30))
    setTradesError(outcome.failed)
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

  const openOrders = myOrders.filter((o) => o.status === 'open' || o.status === 'partial')
  const sortedMine = [...myOrders].sort((a, b) => b.createdAt - a.createdAt)

  /** 成交行视图模型：索引展示行（价格/数量已是人类单位数值），结算列恒「已上链」 */
  const tradeRows = trades.map((t) => ({
    key: t.key,
    timestamp: t.timestamp,
    priceCell: fmtPrice(t.price),
    amountCell: fmtAmount(t.amount),
    chipCls: 'status-settled',
    chipLabel: '已上链',
  }))

  const renderOrdersTable = (orders: Order[], withCancel: boolean) => {
    if (!account) return <Text size="sm" c="dimmed" py="sm">连接钱包后查看订单</Text>
    if (ordersError) return <Text size="sm" c="dimmed" py="sm">中继服务暂时不可用，订单无法加载（资产与跨链不受影响）</Text>
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
                    <HardCancelAction
                      order={o}
                      account={account}
                      getSigner={getSigner}
                      summary={`${o.side === 'buy' ? '买入' : '卖出'} ${fmtAmountCell(o.amount)} ${baseSymbol} @ ${fmtPriceCell(o.price)} ${quoteSymbol}`}
                      onSettled={() => {
                        void fetchMyOrders()
                        void fetchBalances()
                      }}
                    />
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
          {renderOrdersTable(openOrders, true)}
          {account && openOrders.length > 0 && (
            <Text size="xs" c="dimmed" pt="xs">
              撤单统一走「链上撤单」：由你自己的钱包直接上链（自付少量 gas），立即释放这张订单锁住的余额，并在链上永久作废这张订单——作废后任何人都无法再拿它成交。以前的签名撤单是把撤单请求发给节点订单簿，节点已退役、中继簿不提供撤单接口，所以不再提供该按钮；已成交部分不受撤单影响。撤单后中继簿里的这条记录会随订单到期自动清理。
            </Text>
          )}
        </Tabs.Panel>

        <Tabs.Panel value="history" pt="sm">
          {renderOrdersTable(sortedMine, false)}
          {account && (
            <Text size="xs" c="dimmed" pt="xs">
              中继簿只保留还没成交完的挂单，所以这里与「当前挂单」相同；已经成交的记录请看「成交记录」（来自链上索引）。
            </Text>
          )}
        </Tabs.Panel>

        {!mobile && (
        <Tabs.Panel value="trades" pt="sm">
          <Text size="xs" c="dimmed" pb="xs">
            {!INDEXER_ENABLED
              ? '链上索引未配置，成交记录暂不可用'
              : tradesError
                ? '链上索引暂不可达，成交数据暂不可用'
                : '来源：链上索引（Envio），成交以链上事件为准'}
          </Text>
          {tradeRows.length === 0 ? (
            <Text size="sm" c="dimmed" py="sm">
              {tradesError || !INDEXER_ENABLED
                ? '链上索引暂不可用，成交记录无法加载（资产与跨链不受影响）'
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
