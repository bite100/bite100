/**
 * 中继状态区（第 31 轮 §12.6）：三项健康只报实情——
 * 主中继（Workers + D1）：未配置 VITE_RELAY_URL 时如实显示「未部署」，不假绿；
 * 配置后探活 /health。Nostr 镜像与 Envio 索引前端尚未接入读取，如实显示「未知」。
 */
import { useEffect, useState } from 'react'
import { RELAY_URL, RELAY_MODE } from '../config/relay'
import { useShadowMetrics } from '../hooks/useShadowMetrics'
import type { Ratio } from '../services/dualread'
import './RelayStatus.css'

type HealthState = 'ok' | 'bad' | 'unknown' | 'undeployed'

const STATE_LABEL: Record<HealthState, string> = {
  ok: '健康',
  bad: '异常',
  unknown: '未知',
  undeployed: '未部署',
}

interface RelayItem {
  name: string
  state: HealthState
  detail: string
  time: string
}

export function RelayStatus() {
  const [mainState, setMainState] = useState<HealthState>(RELAY_URL ? 'unknown' : 'undeployed')
  const [mainTime, setMainTime] = useState<string>('—')

  useEffect(() => {
    if (!RELAY_URL) return
    let cancelled = false
    ;(async () => {
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 6000)
        const res = await fetch(`${RELAY_URL.replace(/\/$/, '')}/health`, { signal: ctrl.signal })
        clearTimeout(timer)
        if (cancelled) return
        if (!res.ok) {
          setMainState('bad')
          return
        }
        setMainState('ok')
        setMainTime(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
      } catch {
        if (!cancelled) setMainState('bad')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const items: RelayItem[] = [
    {
      name: '主中继（Workers + D1）',
      state: mainState,
      detail:
        mainState === 'undeployed'
          ? '订单中继的代码已就绪但尚未部署到 Cloudflare，当前下单仍走节点通道。部署完成后这里会显示可达性与最近订单同步时间。'
          : mainState === 'ok'
            ? '主中继可达，/health 探活正常。'
            : mainState === 'bad'
              ? '主中继探活失败；下单仍可走节点通道，中继恢复后会自动双路同步。'
              : '正在探活主中继…',
      time: mainState === 'undeployed' ? '—' : mainTime,
    },
    {
      name: 'Nostr 镜像',
      state: 'unknown',
      detail:
        '订单会镜像广播到 Nostr 公共中继（自定义事件类型），但前端尚未接入镜像状态读取，暂时无法在此确认已连接中继数与最近镜像时间。',
      time: '—',
    },
    {
      name: '链上索引（Envio）',
      state: 'unknown',
      detail:
        '成交与结算的链上索引计划用托管索引服务（Envio），尚未接入；接入后这里会显示最新已索引区块与链头滞后块数。',
      time: '—',
    },
  ]

  return (
    <div className="relay-status">
      {items.map((it) => (
        <div key={it.name} className="relay-item">
          <div className="relay-item-head">
            <b>{it.name}</b>
            <span className={`relay-pill relay-${it.state}`}>{STATE_LABEL[it.state]}</span>
          </div>
          <p className="relay-detail">{it.detail}</p>
          <p className="relay-time">最近状态时间：{it.time}</p>
        </div>
      ))}
      {RELAY_MODE !== 'disabled' && <ShadowSection />}
    </div>
  )
}

function fmtRatio(r: Ratio): string {
  if (r.rate === null) return '—（暂无样本）'
  return `${(r.rate * 100).toFixed(2)}%（${r.num}/${r.den}）`
}

function fmtLatency(median: number | null, samples: number): string {
  if (median === null) return '—（暂无样本）'
  return `${(median / 1000).toFixed(1)} 秒（样本 ${samples}）`
}

/**
 * 双读影子对比区（第 34 轮，无节点阶段 2）：仅在 VITE_RELAY_MODE 为
 * shadow/active 时出现。口径说明（用户常设规则：功能变更必须带说明）：
 * 本区逐单比对节点订单簿与公告栏订单簿，并以链上状态复核；shadow 模式
 * 下只观察、不影响交易页订单簿（仍为节点单读）。阶段 3 的准入线写在区尾，
 * 合成测试与真实观察分开统计——本区数字只来自真实双读轮询。
 */
function ShadowSection() {
  const { mode, round, running } = useShadowMetrics()
  const m = round?.metrics ?? null
  const worstDiffs = (m?.bookDiffByPairSide ?? [])
    .filter((d) => d.union > 0)
    .sort((a, b) => (b.diffRate.rate ?? 0) - (a.diffRate.rate ?? 0))
    .slice(0, 3)

  return (
    <div className="relay-item relay-shadow">
      <div className="relay-item-head">
        <b>双读影子对比（无节点阶段 2）</b>
        <span className={`relay-pill ${mode === 'active' ? 'relay-ok' : ''}`}>
          {mode === 'active' ? '合并视图展示中' : '影子模式 · 只观察'}
        </span>
      </div>
      <p className="relay-detail">
        本区把节点订单簿与订单公告栏逐单比对：订单身份按 EIP-712
        摘要在本地重算核对（不信来源自报的摘要），状态用链上金库锁定与
        Settlement 累计成交复核。影子模式下本区只做观察计算，交易页订单簿仍只显示节点数据，不影响下单与撮合；每
        30 秒刷新一轮。「发现延迟」指本页打开后首次在某来源见到该订单的时刻减去下单时刻。
      </p>
      {!m && <p className="relay-detail">{running ? '正在计算第一轮双读…' : '暂无双读数据。'}</p>}
      {round && (round.errors.node || round.errors.relay || round.errors.rpc) && (
        <p className="relay-detail">
          本轮部分来源异常：
          {round.errors.node ? `节点（${round.errors.node}）；` : ''}
          {round.errors.relay ? `公告栏（${round.errors.relay}）；` : ''}
          {round.errors.rpc ? `链上读取（${round.errors.rpc}）；` : ''}
          异常来源的订单一律按「未知」处理，不会混入可成交集。
        </p>
      )}
      {m && (
        <div className="relay-metrics">
          <div className="relay-metric">
            <span>订单总数（共同 / 仅节点 / 仅公告栏）</span>
            <b>
              {m.totals.orders}（{m.totals.common} / {m.totals.nodeOnly} / {m.totals.relayOnly}）
            </b>
          </div>
          <div className="relay-metric">
            <span>共同单核心字段冲突率</span>
            <b>{fmtRatio(m.conflictRateAmongCommon)}</b>
          </div>
          <div className="relay-metric">
            <span>同单状态一致率</span>
            <b>{fmtRatio(m.stateConsistencyRate)}</b>
          </div>
          <div className="relay-metric">
            <span>簿差异率（全部交易对）</span>
            <b>{fmtRatio(m.bookDiffOverall)}</b>
          </div>
          <div className="relay-metric">
            <span>链上无效单比例</span>
            <b>{fmtRatio(m.chainInvalidRatio)}</b>
          </div>
          <div className="relay-metric">
            <span>链上状态未知率</span>
            <b>{fmtRatio(m.unknownRatio)}</b>
          </div>
          <div className="relay-metric">
            <span>可成交误判率（旧口径会展示但链上无效）</span>
            <b>{fmtRatio(m.falseTradeableRate)}</b>
          </div>
          <div className="relay-metric">
            <span>单源独有单比例</span>
            <b>{fmtRatio(m.singleSourceRatio)}</b>
          </div>
          <div className="relay-metric">
            <span>发现延迟中位（节点 / 公告栏）</span>
            <b>
              {fmtLatency(m.discoveryLatencyMs.node.median, m.discoveryLatencyMs.node.samples)} /{' '}
              {fmtLatency(m.discoveryLatencyMs.relay.median, m.discoveryLatencyMs.relay.samples)}
            </b>
          </div>
          <div className="relay-metric">
            <span>三源可用率（节点 / 公告栏 / 链上）</span>
            <b>
              {fmtRatio(m.availability.node)} / {fmtRatio(m.availability.relay)} /{' '}
              {fmtRatio(m.availability.rpc)}
            </b>
          </div>
          <div className="relay-metric">
            <span>分页完整度（节点 / 公告栏）</span>
            <b>
              {m.paginationComplete.node === undefined
                ? '—'
                : m.paginationComplete.node
                  ? '完整'
                  : '可能截断'}
              {' / '}
              {m.paginationComplete.relay === undefined
                ? '—'
                : m.paginationComplete.relay
                  ? '完整'
                  : '可能截断'}
            </b>
          </div>
          {worstDiffs.map((d) => (
            <div className="relay-metric" key={`${d.pair}-${d.side}`}>
              <span>
                簿差异 · {d.pair} {d.side === 'buy' ? '买盘' : '卖盘'}
              </span>
              <b>
                仅节点 {d.onlyNode} · 仅公告栏 {d.onlyRelay} · 字段冲突 {d.conflict} · 数量不同{' '}
                {d.qtyDiff}
                {d.trustworthy ? '' : '（分页未拉完，仅供参考）'}
              </b>
            </div>
          ))}
        </div>
      )}
      <p className="relay-detail">
        阶段 3 准入线：共同单冲突率 0、无无效单或未知单混入可成交集、过滤准确性
        100%、订单发现成功率 ≥99%、共同单状态一致率 ≥99.9%，且连续观察 7
        天并累计 ≥500 张有效订单（双门槛，合成测试与真实观察分开报告）。
      </p>
    </div>
  )
}
