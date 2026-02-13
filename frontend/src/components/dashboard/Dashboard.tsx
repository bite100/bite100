import { useState, useEffect, useCallback } from 'react'
import GridLayout, { verticalCompactor } from 'react-grid-layout'
import { Paper, Text, useMantineTheme, Button } from '@mantine/core'
import { OrderBookWidget } from './OrderBookWidget'
import { KLineChart } from './KLineChart'
import { LimitOrderFormWidget } from './LimitOrderFormWidget'
import { p2pOrderBroadcast } from '../../p2p/orderBroadcast'
import type { Signer } from 'ethers'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'

const LAYOUT_STORAGE_KEY = 'bite100_dashboard_layout'

type LayoutItem = { i: string; x: number; y: number; w: number; h: number; minW?: number; minH?: number }
const defaultLayout: LayoutItem[] = [
  { i: 'orderbook', x: 0, y: 0, w: 3, h: 12, minW: 2, minH: 6 },
  { i: 'chart', x: 3, y: 0, w: 6, h: 12, minW: 4, minH: 8 },
  { i: 'orderform', x: 9, y: 0, w: 3, h: 12, minW: 2, minH: 6 },
]
/** 手机端单列垂直堆叠，避免拖拽误触 */
const mobileLayout: LayoutItem[] = [
  { i: 'orderbook', x: 0, y: 0, w: 4, h: 10, minW: 4, minH: 6 },
  { i: 'chart', x: 0, y: 10, w: 4, h: 10, minW: 4, minH: 6 },
  { i: 'orderform', x: 0, y: 20, w: 4, h: 10, minW: 4, minH: 6 },
]
const MOBILE_BREAKPOINT = 768

export interface DashboardProps {
  account: string | null
  getSigner: () => Promise<Signer | null>
  /** 点击「完整订单簿」时切换为完整视图（我的订单、撤单等） */
  onShowFullOrderbook?: () => void
}

/** 从订单簿买卖盘计算中间价（用于推荐价） */
function computeMidFromBook(
  bids: { price: string }[],
  asks: { price: string }[]
): string {
  const bestBid = bids.length ? Number(bids[0].price) : NaN
  const bestAsk = asks.length ? Number(asks[0].price) : NaN
  if (Number.isNaN(bestBid) || Number.isNaN(bestAsk) || bestBid <= 0 || bestAsk <= 0) return ''
  const mid = (bestBid + bestAsk) / 2
  return mid.toFixed(6)
}

export function Dashboard({ account, getSigner, onShowFullOrderbook }: DashboardProps) {
  const theme = useMantineTheme()
  const [layout, setLayout] = useState(defaultLayout)
  const [width, setWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1200)
  const [recommendedPrice, setRecommendedPrice] = useState('')

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as LayoutItem[]
        if (Array.isArray(parsed) && parsed.length === defaultLayout.length) setLayout(parsed)
      }
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 进入 Dashboard 时启动 P2P（Bootstrap + DHT），便于挂单时广播
  useEffect(() => {
    p2pOrderBroadcast.start().catch(() => {})
  }, [])

  const onLayoutChange = useCallback((newLayout: ReadonlyArray<LayoutItem>) => {
    const next: LayoutItem[] = newLayout.map((item) => ({
      i: item.i,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
      minW: item.minW ?? 2,
      minH: item.minH ?? 6,
    }))
    setLayout(next)
    try {
      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }, [])

  const isMobile = width < MOBILE_BREAKPOINT
  const cols = width >= 1200 ? 12 : width >= 768 ? 10 : 4
  const rowHeight = isMobile ? 36 : 32
  const containerWidth = Math.max(280, width - (isMobile ? 24 : 48))
  const effectiveLayout = isMobile ? mobileLayout : layout
  const effectiveDragConfig = isMobile ? { handle: '.mobile-no-drag' } : { handle: '.drag-handle' }
  const effectiveResizeConfig = isMobile ? { enabled: false } : { enabled: true }

  return (
    <GridLayout
      className={`layout ${isMobile ? 'layout-mobile' : ''}`}
      width={containerWidth}
      layout={effectiveLayout}
      gridConfig={{
        cols,
        rowHeight,
        margin: isMobile ? [6, 6] : [8, 8],
        containerPadding: null,
        maxRows: Infinity,
      }}
      dragConfig={effectiveDragConfig as { handle: string }}
      resizeConfig={effectiveResizeConfig as { enabled: boolean }}
      compactor={verticalCompactor}
      onLayoutChange={onLayoutChange}
    >
      <Paper
        key="orderbook"
        p="md"
        shadow="xs"
        style={{
          background: theme.colors.dark[8] ?? '#2C2E33',
          borderRadius: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <Text className="drag-handle" size="sm" fw={600} c="gray.3" style={{ cursor: 'grab' }}>
            订单簿
          </Text>
          {onShowFullOrderbook && (
            <Button variant="subtle" size="xs" color="gray" onClick={onShowFullOrderbook}>
              完整订单簿
            </Button>
          )}
        </div>
        <OrderBookWidget
          onBookUpdate={(bids, asks) => setRecommendedPrice(computeMidFromBook(bids, asks))}
        />
      </Paper>
      <Paper
        key="chart"
        p="md"
        shadow="xs"
        style={{
          background: theme.colors.dark[8] ?? '#2C2E33',
          borderRadius: 8,
        }}
      >
        <Text className="drag-handle" size="sm" fw={600} c="gray.3" style={{ cursor: 'grab' }}>
          K 线图
        </Text>
        <KLineChart />
      </Paper>
      <Paper
        key="orderform"
        p="md"
        shadow="xs"
        className="dashboard-orderform"
        style={{
          background: theme.colors.dark[8] ?? '#2C2E33',
          borderRadius: 8,
        }}
      >
        <Text className="drag-handle" size="sm" fw={600} c="gray.3" style={{ cursor: isMobile ? 'default' : 'grab' }}>
          挂单
        </Text>
        <LimitOrderFormWidget
          account={account}
          getSigner={getSigner}
          recommendedPrice={recommendedPrice || undefined}
        />
      </Paper>
    </GridLayout>
  )
}
