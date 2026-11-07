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
  { label: '撮合', pct: 40, color: '#ff007a', desc: '订单撮合成交的贡献（现行口径）' },
  { label: '存储', pct: 25, color: '#7a5af8', desc: '订单与数据存储的贡献（现行口径）' },
  { label: '流动性', pct: 20, color: '#089981', desc: '提供流动性的贡献' },
  { label: '中继', pct: 15, color: '#f0b90b', desc: '订单中继转发的贡献' },
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
          <h3 className="card-title">权重构成（现行）</h3>
          <div className="weight-bar" role="img" aria-label="现行权重：撮合 40%、存储 25%、流动性 20%、中继 15%">
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
            新方案「金库飞轮」已经定案（撮合 40 + 存储 25 改走金库：50 按份额·天数给金库存入者、15
            为结算提交加成），尚未启用；启用前按上面的现行权重发放，方案说明在「其他 → 治理与贡献 →
            贡献奖励」里。
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
