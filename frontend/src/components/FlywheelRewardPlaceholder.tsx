/**
 * 贡献奖励新方案占位分区（第 31 轮 §12.2）：金库飞轮方案已定案、尚未启用。
 * 空状态铁律：不出现任何金额估算；领取按钮禁用占位；现行奖励卡在本区上方原样保留，
 * 新方案启用后由本区替换。
 */
import './FlywheelRewardPlaceholder.css'

export function FlywheelRewardPlaceholder() {
  return (
    <section className="card flywheel-card" aria-label="贡献奖励新方案（待启用）">
      <div className="flywheel-head">
        <h3 className="card-title" style={{ margin: 0 }}>
          贡献奖励 · 新方案（金库飞轮）
        </h3>
        <span className="pill">待启用</span>
      </div>
      <p className="flywheel-desc">
        新方案已定（2026-11-08
        拍板）：原「撮合 40 + 存储 25」的 65 个权重百分点改走金库飞轮——50 按份额·天数分给做市金库存入者（在金库里存得越多、越久，份额越大），15
        作为结算提交加成（以实际收到的手续费为上限）；流动性 20、中继 15
        不动。新方案启用前，现行奖励照常在上方卡片领取；启用后本区会替换上方的现行卡。
      </p>
      <div>
        <div className="kv">
          <span className="k">我的份额·天数累计（金库存入）</span>
          <span className="v">奖励尚未启用</span>
        </div>
        <div className="kv">
          <span className="k">结算提交加成（本期）</span>
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
