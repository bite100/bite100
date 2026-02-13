import { useEffect, useState } from 'react'
import { Paper, Text, Table, useMantineTheme } from '@mantine/core'
import { nodeGet } from '../../nodeClient'

const DEFAULT_PAIR = 'TKA/TKB'

export interface OrderBookRow {
  price: string
  amount: string
  side: 'buy' | 'sell'
}

export interface OrderBookWidgetProps {
  /** 订单簿更新时回调，用于计算 mid 等 */
  onBookUpdate?: (bids: OrderBookRow[], asks: OrderBookRow[]) => void
}

export function OrderBookWidget({ onBookUpdate }: OrderBookWidgetProps = {}) {
  const theme = useMantineTheme()
  const [bids, setBids] = useState<OrderBookRow[]>([])
  const [asks, setAsks] = useState<OrderBookRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const fetchBook = async () => {
      try {
        const { data } = await nodeGet<{ pair: string; bids: Array<{ price: string; amount: string }>; asks: Array<{ price: string; amount: string }> }>(
          '/api/orderbook',
          { pair: DEFAULT_PAIR }
        )
        if (cancelled) return
        const newBids = (data.bids ?? []).slice(0, 15).map((o) => ({ price: o.price, amount: o.amount, side: 'buy' as const }))
        const newAsks = (data.asks ?? []).slice(0, 15).map((o) => ({ price: o.price, amount: o.amount, side: 'sell' as const }))
        setBids(newBids)
        setAsks(newAsks)
        onBookUpdate?.(newBids, newAsks)
      } catch {
        if (!cancelled) {
          setBids([])
          setAsks([])
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchBook()
    const t = setInterval(fetchBook, 5000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [onBookUpdate])

  return (
    <Paper p="md" style={{ background: theme.colors.dark[8] ?? '#2C2E33', height: '100%', minHeight: 280 }}>
      <Text size="sm" fw={600} mb="xs" c="gray.3">
        订单簿 · {DEFAULT_PAIR}
      </Text>
      {loading ? (
        <Text size="xs" c="dimmed">加载中…</Text>
      ) : (
        <>
          <Table striped highlightOnHover withTableBorder={false}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th style={{ color: '#EF5350' }}>卖价</Table.Th>
                <Table.Th>数量</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {asks.slice(0, 8).map((r, i) => (
                <Table.Tr key={`a-${i}`}>
                  <Table.Td style={{ color: '#EF5350' }}>{Number(r.price).toFixed(4)}</Table.Td>
                  <Table.Td>{Number(r.amount).toFixed(4)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          <Table striped highlightOnHover withTableBorder={false}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th style={{ color: '#26A69A' }}>买价</Table.Th>
                <Table.Th>数量</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {bids.slice(0, 8).map((r, i) => (
                <Table.Tr key={`b-${i}`}>
                  <Table.Td style={{ color: '#26A69A' }}>{Number(r.price).toFixed(4)}</Table.Td>
                  <Table.Td>{Number(r.amount).toFixed(4)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </>
      )}
    </Paper>
  )
}
