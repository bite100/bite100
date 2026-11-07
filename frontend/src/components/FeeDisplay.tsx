import { formatEther } from 'ethers'
import { useGasEstimate } from '../hooks/useGasEstimate'

export interface FeeDisplayProps {
  /** 交易金额（可选，用于显示平台费金额） */
  tradeAmount?: bigint
  /** 平台手续费百分比，如 0.01 表示 0.01%（链上 feeBps=1，成交时从成交金额中扣除） */
  platformFeePercent?: number
  /**
   * 手续费分成（占手续费的百分比，总和 100）——与链上 FeeDistributor 口径一致：
   * 开发者 1% 在成交时自动到账；其余 99% 留在分配池，按治理设定的名单与权重定期分配、由领取人自行领取。
   */
  feeDistribution?: {
    developers: number
    distributionPool: number
  }
  /** 是否显示 Gas 估算（需要钱包/网络） */
  showGasEstimate?: boolean
  className?: string
}

const DEFAULT_FEE_PERCENT = 0.01
const DEFAULT_DISTRIBUTION = { developers: 1, distributionPool: 99 }

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
          <span className="label">交易手续费</span>
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
                <span className="gas-relayer">（中继代付、结算时双方对半分摊：你承担的一半以你收到的资产扣除，无需自备原生代币）</span>
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
        <h4 className="fee-display-subtitle">手续费分成（占手续费）</h4>
        <div className="fee-display-rows">
          <div className="fee-display-row">
            <span className="label">开发者（成交时自动到账）</span>
            <span className="value">{feeDistribution.developers}%</span>
          </div>
          <div className="fee-display-row">
            <span className="label">贡献者分配池（按治理权重定期分配）</span>
            <span className="value">{feeDistribution.distributionPool}%</span>
          </div>
        </div>
      </div>
      <p className="fee-display-note">
        费用说明：交易手续费为成交金额的 0.01%，与 gas 分摊是两条独立的账。结算 gas 由中继先行代付，
        你不需要准备原生代币；成交结算时按该笔结算的实际 gas 成本由买卖双方各承担一半，
        以各自收到的资产扣除（卖方从收到的计价币扣、买方从收到的基础币扣），单方扣除不超过其收到金额的 10%，
        超出部分平台吸收。预计到账 = 成交金额 − 交易手续费 − 你承担的那一半 gas。
        若因你自己的订单已过期或已被你撤单导致结算失败，失败所耗的 gas 由你承担；
        与你无关的系统性失败不会扣你的钱。存入与提取 Vault 的 gas 由你自己支付。
      </p>
    </div>
  )
}
