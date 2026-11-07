import { Paper, Text, Button, Select } from '@mantine/core'
import type { PairStats } from '../../hooks/usePairStats'
import { TRADE_PAIRS, type TradePair } from '../../config/pairs'

export interface PairStatsBarProps {
  pair: string
  stats: PairStats
  /** 订单簿中间价（无成交时最新价的兜底，来自现有订单簿管道） */
  midPrice?: string
  /** 第二十五轮：交易对切换（选中对写 URL ?pair=，交易台各组件随对切换） */
  onPairChange?: (pair: TradePair) => void
  onShowFullOrderbook?: () => void
}

function fmt(n: number | null | undefined, digits = 4): string {
  if (n == null || Number.isNaN(n)) return '—'
  return n.toFixed(digits)
}

function fmtCompact(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  if (Math.abs(n) >= 10000) return n.toFixed(2)
  if (Math.abs(n) >= 1) return n.toFixed(4)
  return n.toFixed(6)
}

/**
 * 交易主屏顶部信息条（布局对标 Hyperliquid 顶部统计行）：
 * 交易对、最新价、24h 涨跌、24h 高/低、24h 成交量——全部来自 /api/trades 推导（见 usePairStats）。
 * 本应用没有标记价格/指数价格/资金费率等永续概念，故不设对应字段。
 */
export function PairStatsBar({ pair, stats, midPrice, onPairChange, onShowFullOrderbook }: PairStatsBarProps) {
  const [base, quote] = pair.split('/')
  const lastPrice = stats.lastPrice ?? (midPrice ? Number(midPrice) : null)
  const change = stats.change24hPct
  const changeColor =
    change == null ? 'var(--b100-text-2)' : change >= 0 ? 'var(--b100-up)' : 'var(--b100-down)'

  return (
    <Paper className="trade-stats" p="md" shadow="xs" withBorder>
      <div className="ts-pair">
        {onPairChange ? (
          <Select
            aria-label="交易对"
            data={TRADE_PAIRS.map((p) => ({ value: p, label: p }))}
            value={pair}
            onChange={(v) => {
              if (v) onPairChange(v as TradePair)
            }}
            size="md"
            fw={700}
            w={160}
          />
        ) : (
          <Text fw={700} size="lg" lh={1.15}>
            {base}/{quote}
          </Text>
        )}
        <Text size="xs" c="dimmed">
          现货 · 订单簿
        </Text>
      </div>

      <div className="ts-item">
        <Text size="xs" c="dimmed">最新价</Text>
        <Text className="ts-value" fw={600} style={{ color: changeColor }}>
          {fmt(lastPrice)}
        </Text>
      </div>

      <div className="ts-item">
        <Text size="xs" c="dimmed">24h 涨跌</Text>
        <Text className="ts-value" fw={600} style={{ color: changeColor }}>
          {change == null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}
        </Text>
      </div>

      <div className="ts-item">
        <Text size="xs" c="dimmed">24h 最高</Text>
        <Text className="ts-value">{fmt(stats.high24h)}</Text>
      </div>

      <div className="ts-item">
        <Text size="xs" c="dimmed">24h 最低</Text>
        <Text className="ts-value">{fmt(stats.low24h)}</Text>
      </div>

      <div className="ts-item">
        <Text size="xs" c="dimmed">24h 成交量</Text>
        <Text className="ts-value">
          {fmtCompact(stats.volume24hBase)} <span className="ts-unit">{base}</span>
        </Text>
        <Text size="xs" c="dimmed" className="ts-sub">
          ≈ {fmtCompact(stats.volume24hQuote)} {quote}
        </Text>
      </div>

      {onShowFullOrderbook && (
        <div className="ts-action">
          <Button variant="light" color="brand" size="xs" onClick={onShowFullOrderbook}>
            完整订单簿
          </Button>
        </div>
      )}
    </Paper>
  )
}
