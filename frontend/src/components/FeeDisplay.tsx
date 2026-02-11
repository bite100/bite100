import { formatEther } from 'ethers'
import { useGasEstimate } from '../hooks/useGasEstimate'

export interface FeeDisplayProps {
  /** 交易金额（可选，用于显示平台费金额） */
  tradeAmount?: bigint
  /** 平台手续费百分比，如 0.01 表示 0.01%（与概念设计一致，单边最高等值 1 USD） */
  platformFeePercent?: number
  /** 手续费分成比例（百分比），总和应为 100 */
  feeDistribution?: {
    nodes: number
    developers: number
    liquidity: number
  }
  /** 是否显示 Gas 估算（需要钱包/网络） */
  showGasEstimate?: boolean
  className?: string
}

const DEFAULT_FEE_PERCENT = 0.01
const DEFAULT_DISTRIBUTION = { nodes: 20, developers: 30, liquidity: 50 }

export function FeeDisplay({
  platformFeePercent = DEFAULT_FEE_PERCENT,
  feeDistribution = DEFAULT_DISTRIBUTION,
  showGasEstimate = true,
  className = '',
}: FeeDisplayProps) {
  const { estimate: gasEstimate, loading: gasLoading } = useGasEstimate(showGasEstimate)
  return (
    <div className={`fee-display ${className}`.trim()}>
      <h3 className="fee-display-title">预计费用</h3>
      <div className="fee-display-rows">
        <div className="fee-display-row">
          <span className="label">平台手续费</span>
          <span className="value">{platformFeePercent}%</span>
        </div>
        {showGasEstimate && (
          <div className="fee-display-row">
            <span className="label">Gas 费用</span>
            {gasLoading ? (
              <span className="value muted">计算中…</span>
            ) : gasEstimate ? (
              <span className="value">
                ≈ {formatEther(gasEstimate.totalCost)} ETH
                <span className="gas-relayer">（由 relayer 代付）</span>
                {gasEstimate.suggestion && (
                  <span className="gas-suggestion" title={gasEstimate.suggestion}>
                    {gasEstimate.suggestion}
                  </span>
                )}
              </span>
            ) : (
              <span className="value muted">—</span>
            )}
          </div>
        )}
      </div>
      <div className="fee-display-split">
        <h4 className="fee-display-subtitle">手续费分成去向</h4>
        <div className="fee-display-rows">
          <div className="fee-display-row">
            <span className="label">节点运行者</span>
            <span className="value">{feeDistribution.nodes}%</span>
          </div>
          <div className="fee-display-row">
            <span className="label">开发者</span>
            <span className="value">{feeDistribution.developers}%</span>
          </div>
          <div className="fee-display-row">
            <span className="label">流动性提供者</span>
            <span className="value">{feeDistribution.liquidity}%</span>
          </div>
        </div>
      </div>
    </div>
  )
}
