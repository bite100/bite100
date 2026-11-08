/**
 * 贡献奖励新方案占位分区（第 31 轮 §12.2 建卡；第 42 轮按定版口径更新文案）：
 * 四线权重已定版（挂单 35 / gas 库存款 25 / 中继 20 / 结算提交 20）、合约常量
 * 已落地，新部署启用前本区仍为占位。
 * 空状态铁律：不出现任何金额估算；领取按钮禁用占位；现行奖励卡在本区上方原样保留，
 * 新方案启用后由本区替换。
 */
import './FlywheelRewardPlaceholder.css'

export function FlywheelRewardPlaceholder() {
  return (
    <section className="card flywheel-card" aria-label="贡献奖励新方案（待启用）">
      <div className="flywheel-head">
        <h3 className="card-title" style={{ margin: 0 }}>
          贡献奖励 · 新方案（定版权重）
        </h3>
        <span className="pill">待启用</span>
      </div>
      <p className="flywheel-desc">
        分成权重已定版（2026-11-08 拍板）：盘口挂单 35（按挂单时长 × 深度计分）、gas
        库存款 25（按份额 × 时长计分）、中继 20、结算提交 20，合计 100，取代做市时代的旧
        方案。金库已改定为 gas 库——存款只作结算 gas 的垫付周转金，平台不做市；结算计量
        差额（shortfall）由 gas 库吸收，存款人的 25% 分成已包含这份风险补偿。新方案启用
        前，现行奖励照常在上方卡片领取；启用后本区会替换上方的现行卡。
      </p>
      <div>
        <div className="kv">
          <span className="k">我的 gas 库存款累计（份额·时长）</span>
          <span className="v">奖励尚未启用</span>
        </div>
        <div className="kv">
          <span className="k">我的挂单积分（时长 × 深度，本期）</span>
          <span className="v">—</span>
        </div>
        <div className="kv">
          <span className="k">待领取</span>
          <span className="v">—</span>
        </div>
      </div>
      <button type="button" className="btn secondary flywheel-claim" disabled>
        领取奖励（新方案启用后开放）
      </button>
      <div className="flywheel-history">
        <span>奖励历史（份额·天数明细 / 加成记录 / 领取记录）</span>
        <span className="pill">启用后开放</span>
      </div>
    </section>
  )
}
