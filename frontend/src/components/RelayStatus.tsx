/**
 * 中继状态区（第 31 轮 §12.6）：三项健康只报实情——
 * 主中继（Workers + D1）：未配置 VITE_RELAY_URL 时如实显示「未部署」，不假绿；
 * 配置后探活 /health。Nostr 镜像与 Envio 索引前端尚未接入读取，如实显示「未知」。
 */
import { useEffect, useState } from 'react'
import { RELAY_URL } from '../config/relay'
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
    </div>
  )
}
