/**
 * 中继状态区（第 31 轮 §12.6，第 34 轮更新，第 51 轮单源化）：健康只报实情——
 * 主中继（Workers + D1）：未配置 VITE_RELAY_URL 时如实显示「未部署」，不假绿；
 * 配置后探活 /health。第 51 轮（无节点阶段 5）起主中继是唯一的订单通道
 * （下单、订单簿都走它），文案按单源事实呈现。
 * Nostr 镜像前端尚未接入读取，如实显示「未知」。
 * Envio 索引：未配置 VITE_INDEXER_URL 显示「未部署」；配置后以最小
 * GraphQL 查询探活，成交记录的唯一展示源。
 * 原「双读影子对比」区（第 34 轮）随节点退役删除：双读的前提（节点源）
 * 已不存在，影子指标与三态模式说明一并退役。
 */
import { useEffect, useState } from 'react'
import { RELAY_URL } from '../config/relay'
import { INDEXER_URL, INDEXER_ENABLED } from '../config/indexer'
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
  const [indexerState, setIndexerState] = useState<HealthState>(
    INDEXER_ENABLED ? 'unknown' : 'undeployed',
  )
  const [indexerTime, setIndexerTime] = useState<string>('—')

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

  // Envio 索引探活：已配置端点时用最小 GraphQL 查询（{__typename}）验可达
  useEffect(() => {
    if (!INDEXER_ENABLED) return
    let cancelled = false
    ;(async () => {
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 6000)
        const res = await fetch(INDEXER_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: '{ __typename }' }),
          signal: ctrl.signal,
        })
        clearTimeout(timer)
        if (cancelled) return
        if (!res.ok) {
          setIndexerState('bad')
          return
        }
        setIndexerState('ok')
        setIndexerTime(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
      } catch {
        if (!cancelled) setIndexerState('bad')
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
          ? '订单中继的代码已就绪但尚未部署到 Cloudflare。下单与订单簿都经主中继，部署并配置 VITE_RELAY_URL 后这里会显示可达性。'
          : mainState === 'ok'
            ? '主中继可达，/health 探活正常。下单、订单簿与「我的订单」都经主中继（节点已退役，没有备用通道）。'
            : mainState === 'bad'
              ? '主中继探活失败：下单与订单簿暂时不可用（链上资产、余额与跨链不受影响）；撤单仍可走钱包直连链上的「链上撤单」。'
              : '正在探活主中继…',
      time: mainState === 'undeployed' ? '—' : mainTime,
    },
    {
      name: 'Nostr 镜像',
      state: 'unknown',
      detail:
        '订单会镜像广播到 Nostr 公共中继（自定义事件类型），但前端尚未接入镜像状态读取，暂时无法在此确认已连接中继数与最近镜像时间。镜像只是备份广播，订单以主中继（D1）为准。',
      time: '—',
    },
    {
      name: '链上索引（Envio）',
      state: indexerState,
      detail:
        indexerState === 'undeployed'
          ? '索引器代码已就绪（仓库 indexer/ 目录，双链 Settlement 成交 + gas 分摊），但尚未部署到 Envio Cloud、前端也未配置端点；成交记录暂不可用。部署并配置 VITE_INDEXER_URL 后，成交记录以链上索引为展示来源。'
          : indexerState === 'ok'
            ? '链上索引端点可达，成交记录以索引为展示来源。索引只是链上事件的展示缓存，成交对错以链上为准。'
            : indexerState === 'bad'
              ? '链上索引端点探活失败；成交记录暂不可用（不影响下单与订单簿），索引恢复后自动恢复展示。'
              : '正在探活链上索引端点…',
      time: indexerState === 'undeployed' ? '—' : indexerTime,
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
      <div className="relay-item">
        <div className="relay-item-head">
          <b>节点退役（无节点阶段 5）</b>
        </div>
        <p className="relay-detail">
          原 P2P 节点已下线退役：下单只经主中继、订单簿只读中继簿、成交记录只读链上索引，订单的可成交校验仍由前端逐单重算签名摘要并以链上状态复核（校验口径未变）。撤单统一走「链上撤单」（钱包直接上链释放锁定并永久作废订单）；中继簿不提供撤单接口，簿面记录会随订单到期自动清理。
        </p>
      </div>
    </div>
  )
}
