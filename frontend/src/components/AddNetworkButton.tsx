/**
 * 一键添加网络到钱包（wallet_addEthereumChain）
 * 用于在连接前或连接后将当前/默认链添加到 MetaMask 等钱包
 */
import { useState } from 'react'
import { getEthereum } from '../utils'
import { DEFAULT_CHAIN_ID, getChainConfig, getAddChainParams } from '../config/chains'

interface AddNetworkButtonProps {
  /** 要添加的链 ID，不传则用默认链（如 Sepolia） */
  chainId?: number
  /** 按钮样式类名 */
  className?: string
  /** 是否使用次要样式 */
  variant?: 'primary' | 'secondary'
}

export function AddNetworkButton({
  chainId = DEFAULT_CHAIN_ID,
  className = '',
  variant = 'secondary',
}: AddNetworkButtonProps) {
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const config = getChainConfig(chainId)
  const label = config ? `添加 ${config.name} 到钱包` : '添加网络'

  const handleClick = async () => {
    const ethereum = getEthereum()
    if (!ethereum) {
      setError('未检测到钱包（请安装 MetaMask 等）')
      return
    }
    setError(null)
    setAdding(true)
    try {
      const params = getAddChainParams(chainId)
      await ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [params],
      })
    } catch (e: unknown) {
      const err = e as { code?: number; message?: string }
      if (err.code === 4001) {
        setError('已取消')
      } else {
        setError(err.message || '添加失败')
      }
    } finally {
      setAdding(false)
    }
  }

  if (!config) return null

  return (
    <div className="add-network-wrap">
      <button
        type="button"
        className={`btn ${variant} add-network-btn ${className}`.trim()}
        onClick={handleClick}
        disabled={adding}
      >
        {adding ? '添加中…' : label}
      </button>
      {error && (
        <p className="add-network-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
