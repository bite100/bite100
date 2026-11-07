import { useCallback, useEffect, useState } from 'react'
import { Tabs, Text, Button } from '@mantine/core'
import { Contract } from 'ethers'
import { nodeGet, nodePost } from '../../nodeClient'
import { signCancelOrder } from '../../services/orderSigning'
import { formatError, formatTokenAmount, getProvider } from '../../utils'
import { ERC20_ABI, VAULT_ABI, VAULT_ADDRESS, TOKEN0_ADDRESS, TOKEN1_ADDRESS } from '../../config'
import type { Order, Trade } from '../../OrderBookSection'
import type { Signer } from 'ethers'

const DEFAULT_PAIR = 'TKA/TKB'
const [BASE_SYMBOL, QUOTE_SYMBOL] = DEFAULT_PAIR.split('/')
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
  account: string | null
  getSigner: () => Promise<Signer | null>
  /** 下单成功后递增，触发挂单列表刷新 */
  refreshSignal?: number
}

function fmtCell(v: string): string {
  const n = Number(v)
  return Number.isFinite(n) ? n.toFixed(4) : v
}

function fmtTime(sec: number): string {
  if (!sec) return '—'
  return new Date(sec * 1000).toLocaleString()
}

interface BalanceRow {
  symbol: string
  wallet: string
  vault: string
}

/**
 * K 线下方页签区（布局对标 Hyperliquid 底部表格区）：
 * 当前挂单 / 历史订单 / 成交记录 / 余额——实体全部来自本应用既有管道
 * （节点 /api/orders、/api/trades 与链上 ERC20/Vault 余额），无持仓/杠杆类概念。
 */
export function TradeTabsPanel({ account, getSigner, refreshSignal = 0 }: TradeTabsPanelProps) {
  const [tab, setTab] = useState<string | null>('open')
  const [myOrders, setMyOrders] = useState<Order[]>([])
  const [trades, setTrades] = useState<Trade[]>([])
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
        pair: DEFAULT_PAIR,
        limit: '50',
      })
      setMyOrders(Array.isArray(data) ? data : [])
      setNodeError(false)
    } catch {
      setNodeError(true)
    }
  }, [account])

  const fetchTrades = useCallback(async () => {
    try {
      const { data } = await nodeGet<Trade[]>('/api/trades', { pair: DEFAULT_PAIR, limit: '30' })
      setTrades(Array.isArray(data) ? data : [])
      setTradesError(false)
    } catch {
      /* 成交拉取失败保留旧数据；从未成功过时由 tradesError 呈现节点未连接空态 */
      setTradesError(true)
    }
  }, [])

  const fetchBalances = useCallback(async () => {
    if (!account) {
      setBalances([])
      return
    }
    try {
      const provider = getProvider()
      if (!provider) return
      const vault = new Contract(VAULT_ADDRESS, VAULT_ABI, provider)
      const rows: BalanceRow[] = []
      for (const [symbol, addr] of [
        [BASE_SYMBOL, TOKEN0_ADDRESS],
        [QUOTE_SYMBOL, TOKEN1_ADDRESS],
      ] as const) {
        const token = new Contract(addr, ERC20_ABI, provider)
        const [w, v] = await Promise.all([
          token.balanceOf(account),
          vault.balanceOf(addr, account).catch(() => 0n),
        ])
        rows.push({ symbol, wallet: formatTokenAmount(w), vault: formatTokenAmount(v as bigint) })
      }
      setBalances(rows)
    } catch {
      setBalances([])
    }
  }, [account])

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
      const signature = await signCancelOrder(orderId, account, timestamp, signer)
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

  const renderOrdersTable = (orders: Order[], withCancel: boolean) => {
    if (!account) return <Text size="sm" c="dimmed" py="sm">连接钱包后查看订单</Text>
    if (nodeError) return <Text size="sm" c="dimmed" py="sm">节点未连接，订单暂不可用（需配置节点 API）</Text>
    if (orders.length === 0) return <Text size="sm" c="dimmed" py="sm">暂无订单</Text>
    return (
      <div className="trade-table-wrap">
        <table className="trade-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>方向</th>
              <th>价格 ({QUOTE_SYMBOL})</th>
              <th>数量 ({BASE_SYMBOL})</th>
              <th>已成交</th>
              <th>状态</th>
              {withCancel && <th></th>}
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.orderId}>
                <td>{fmtTime(o.createdAt)}</td>
                <td style={{ color: o.side === 'buy' ? 'var(--b100-up)' : 'var(--b100-down)' }}>
                  {o.side === 'buy' ? '买入' : '卖出'}
                </td>
                <td className="num">{fmtCell(o.price)}</td>
                <td className="num">{fmtCell(o.amount)}</td>
                <td className="num">{fmtCell(o.filled)}</td>
                <td>{STATUS_LABEL[o.status] ?? o.status}</td>
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
          <Tabs.Tab value="open">当前挂单{openOrders.length > 0 ? ` (${openOrders.length})` : ''}</Tabs.Tab>
          <Tabs.Tab value="history">历史订单</Tabs.Tab>
          <Tabs.Tab value="trades">成交记录</Tabs.Tab>
          <Tabs.Tab value="balance">余额</Tabs.Tab>
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

        <Tabs.Panel value="trades" pt="sm">
          {sortedTrades.length === 0 ? (
            <Text size="sm" c="dimmed" py="sm">
              {tradesError ? '节点未连接，成交记录暂不可用（需配置节点 API）' : '暂无成交'}
            </Text>
          ) : (
            <div className="trade-table-wrap">
              <table className="trade-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>价格 ({QUOTE_SYMBOL})</th>
                    <th>数量 ({BASE_SYMBOL})</th>
                    <th>结算</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedTrades.slice(0, 30).map((t) => (
                    <tr key={t.tradeId}>
                      <td>{fmtTime(t.timestamp)}</td>
                      <td className="num">{fmtCell(t.price)}</td>
                      <td className="num">{fmtCell(t.amount)}</td>
                      <td>
                        {t.txHash ? (
                          <span style={{ color: 'var(--b100-up)' }}>已上链</span>
                        ) : (
                          <span style={{ color: 'var(--b100-text-2)' }}>待结算</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Tabs.Panel>

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
                    <th>钱包余额</th>
                    <th>Vault 余额</th>
                  </tr>
                </thead>
                <tbody>
                  {balances.map((r) => (
                    <tr key={r.symbol}>
                      <td>{r.symbol}</td>
                      <td className="num">{r.wallet}</td>
                      <td className="num">{r.vault}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Tabs.Panel>
      </Tabs>
    </div>
  )
}
