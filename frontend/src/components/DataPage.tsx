/**
 * 数据内容页（第 31 轮）：原「数据」页解散后的落点，经「其他」页数据组进入（二级页）。
 * 内容 = 奖励池（既有 RewardPoolInfo 组件原样）+ 现行权重构成 + 期次记录 +
 * 合约地址（原页脚内容搬入）+ 中继状态区（§12.6，只报实情）。
 */
import { useEffect } from 'react'
import { RewardPoolInfo } from './RewardPoolInfo'
import { RelayStatus } from './RelayStatus'
import {
  getClaimDeadline,
  getLastTwoPeriods,
  isPastClaimDeadline,
} from '../services/contributorRewardUtils'
import './DataPage.css'

interface DataPageProps {
  anchor: string | null
  chainName: string
  vaultAddress: string
  settlementAddress: string
  governanceAddress: string
}

const WEIGHT_SEGMENTS: { label: string; pct: number; color: string; desc: string }[] = [
  { label: '盘口挂单', pct: 35, color: '#ff007a', desc: '在订单簿挂单提供深度，按挂单时长 × 深度计分' },
  { label: 'gas 库存款', pct: 25, color: '#089981', desc: '向 gas 库注资作结算垫付周转金，按份额 × 时长计分' },
  { label: '中继', pct: 20, color: '#7a5af8', desc: '订单中继转发的贡献' },
  { label: '结算提交', pct: 20, color: '#f0b90b', desc: '把成交提交上链结算、垫付结算 gas 的贡献' },
]

function shortAddr(a: string): string {
  return a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a
}

export function DataPage({ anchor, chainName, vaultAddress, settlementAddress, governanceAddress }: DataPageProps) {
  useEffect(() => {
    if (!anchor) return
    const t = setTimeout(() => {
      document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 60)
    return () => clearTimeout(t)
  }, [anchor])

  const periods = getLastTwoPeriods()

  return (
    <div className="data-page">
      <p className="data-intro">
        这里都是公开数据，不用连接钱包也能看：奖励池余额、权重构成、期次与合约地址都来自链上与治理参数。
      </p>

      <div id="data-rewards" className="data-anchor">
        <RewardPoolInfo />
        <section className="card">
          <h3 className="card-title">权重构成（定版）</h3>
          <div className="weight-bar" role="img" aria-label="定版权重：盘口挂单 35%、gas 库存款 25%、中继 20%、结算提交 20%">
            {WEIGHT_SEGMENTS.map((s) => (
              <span key={s.label} style={{ width: `${s.pct}%`, background: s.color }} />
            ))}
          </div>
          <div>
            {WEIGHT_SEGMENTS.map((s) => (
              <div key={s.label} className="kv">
                <span className="k">
                  <span className="weight-dot" style={{ background: s.color }} />
                  {s.label} · {s.desc}
                </span>
                <span className="v num">{s.pct}%</span>
              </div>
            ))}
          </div>
          <p className="data-note">
            上面是 2026-11-08 定版的四线权重，取代旧口径（撮合 40 / 存储 25 / 流动性 20 / 中继
            15）与做市时代方案。为什么这样分：平台不做市后，盘口深度全靠挂单，第一位给挂单；
            gas 库存款人出的是小额周转金，25 已含风险补偿；中继在无节点化后以平台自有设施为主，
            留 20 给第三方中继；开放提交后提交者真金垫付 gas，定 20。金库已改定为 gas
            库：结算计量差额（shortfall）由 gas 库（存款人资金）吸收。合约常量已按定版落地，
            新部署启用前在网部署仍按旧权重发放；方案说明在「其他 → 治理与贡献 → 贡献奖励」里。
          </p>
        </section>
      </div>

      <section className="card data-anchor" id="data-periods">
        <h3 className="card-title">期次记录</h3>
        <div>
          {periods.map((p) => {
            const deadline = getClaimDeadline(p)
            const past = isPastClaimDeadline(p)
            return (
              <div key={p} className="kv">
                <span className="k">贡献奖励 · {p}</span>
                <span className="v">
                  {past ? '已过领取期' : '领取中'}
                  <small>
                    领取截止：
                    {deadline
                      ? deadline.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
                      : '—'}
                  </small>
                </span>
              </div>
            )
          })}
        </div>
        <p className="data-note">领取入口在「其他 → 治理与贡献 → 贡献奖励」，连接钱包后按期次领取。</p>
      </section>

      <section className="card data-anchor" id="data-contracts">
        <h3 className="card-title">合约地址</h3>
        <div>
          <div className="kv">
            <span className="k">当前网络</span>
            <span className="v">{chainName}</span>
          </div>
          <div className="kv">
            <span className="k">金库 Vault</span>
            <span className="v num" title={vaultAddress}>
              {shortAddr(vaultAddress)}
            </span>
          </div>
          <div className="kv">
            <span className="k">结算 Settlement</span>
            <span className="v num" title={settlementAddress}>
              {shortAddr(settlementAddress)}
            </span>
          </div>
          <div className="kv">
            <span className="k">治理 Governance</span>
            <span className="v num" title={governanceAddress}>
              {shortAddr(governanceAddress)}
            </span>
          </div>
        </div>
        <p className="data-note">地址随顶栏所选网络变化；在区块浏览器里可以核对每一笔存入、结算与投票。</p>
      </section>

      <section className="card data-anchor" id="data-relay">
        <h3 className="card-title">中继状态</h3>
        <RelayStatus />
      </section>
    </div>
  )
}
