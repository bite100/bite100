import { useState, useCallback, useEffect } from 'react'
import { AbiCoder, Contract, ZeroAddress } from 'ethers'
import { SUPPORTED_CHAINS, getChainConfig } from '../config/chains'
import { getProvider, withSigner, formatTokenAmount, formatError } from '../utils'
import { ErrorDisplay } from './ErrorDisplay'
import { ERC20_ABI } from '../config'
import './CrossChainBridge.css'

interface CrossChainBridgeProps {
  account: string | null
  currentChainId: number | null
}

const CROSS_CHAIN_BRIDGE_ABI = [
  'function bridgeToken(address token, uint256 amount, uint32 dstChainId, bytes calldata options) payable',
  'function quoteBridgeFee(uint32 dstChainId, bytes calldata payload, bytes calldata options) view returns (uint256 nativeFee, uint256 lzTokenFee)',
  'function supportedTokens(address token) view returns (bool)',
  'function tokenMapping(uint16 chainId, address token) view returns (address)',
  'function getBridgeStatus(bytes32 requestId) view returns (uint8 status, uint256 initiatedAt, uint256 completedAt, uint256 attempts)',
  'function retryBridge(bytes32 requestId, uint32 dstChainId, bytes calldata options) payable',
  'event BridgeInitiated(bytes32 indexed requestId, address indexed user, address indexed token, uint256 amount, uint32 dstChainId)',
  'event BridgeStatusUpdated(bytes32 indexed requestId, uint8 status, uint256 timestamp)',
] as const

// LayerZero EID（Endpoint ID）映射
const LAYERZERO_EIDS: Record<number, number> = {
  1: 30110,        // Ethereum Mainnet
  8453: 30184,     // Base Mainnet
  42161: 30110,    // Arbitrum One
  137: 30109,      // Polygon
  10: 30111,       // Optimism
  11155111: 40161, // Sepolia
  84532: 40245,    // Base Sepolia
  421614: 40231,   // Arbitrum Sepolia
}

export function CrossChainBridge({ account, currentChainId }: CrossChainBridgeProps) {
  const [sourceChainId, setSourceChainId] = useState<number | null>(currentChainId)
  const [targetChainId, setTargetChainId] = useState<number | null>(null)
  const [tokenAddress, setTokenAddress] = useState<string>('')
  const [amount, setAmount] = useState<string>('')
  const [balance, setBalance] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [bridgeAddress, setBridgeAddress] = useState<string>('')
  const [estimatedFee, setEstimatedFee] = useState<string>('')
  const [bridgeStatus, setBridgeStatus] = useState<string>('')
  const [lastRequestId, setLastRequestId] = useState<string | null>(null)

  // 获取余额
  const fetchBalance = useCallback(async () => {
    if (!account || !tokenAddress || !sourceChainId) {
      setBalance('0')
      return
    }

    try {
      const provider = getProvider()
      if (!provider) return

      const token = new Contract(tokenAddress, ERC20_ABI, provider)
      const bal = await token.balanceOf(account)
      setBalance(formatTokenAmount(bal))
    } catch (e) {
      setBalance('0')
    }
  }, [account, tokenAddress, sourceChainId])

  useEffect(() => {
    fetchBalance()
  }, [fetchBalance])

  // 获取桥接费用估算（优化：更精确的费用计算）
  const estimateFee = useCallback(async () => {
    if (!targetChainId || !tokenAddress || !amount || !sourceChainId || !bridgeAddress) {
      setEstimatedFee('')
      return null
    }

    try {
      const provider = getProvider()
      if (!provider) return null

      const bridge = new Contract(bridgeAddress, CROSS_CHAIN_BRIDGE_ABI, provider)
      
      // 构建实际的payload（包含用户地址、代币、数量等）
      const amountBigInt = BigInt(Math.floor(parseFloat(amount) * 1e18))
      const payload = AbiCoder.defaultAbiCoder().encode(
        ['tuple(address,address,uint256,uint32,uint256)'],
        [[account || ZeroAddress, tokenAddress, amountBigInt, LAYERZERO_EIDS[targetChainId] || 0, Math.floor(Date.now() / 1000)]]
      )
      const options = '0x' // 默认选项
      
      // 获取 LayerZero EID
      const dstEid = LAYERZERO_EIDS[targetChainId]
      if (!dstEid) {
        setEstimatedFee('无法估算费用')
        return null
      }

      const [nativeFee] = await bridge.quoteBridgeFee(dstEid, payload, options)
      const feeFormatted = formatTokenAmount(nativeFee)
      setEstimatedFee(`预计费用: ${feeFormatted} ETH`)
      return nativeFee
    } catch (e: any) {
      console.error('估算费用失败:', e)
      setEstimatedFee('费用估算失败')
      return null
    }
  }, [targetChainId, tokenAddress, amount, sourceChainId, bridgeAddress, account])
  
  // 状态查询优化：定期查询跨链状态
  const checkBridgeStatus = useCallback(async (requestId: string) => {
    if (!bridgeAddress || !requestId) return
    
    try {
      const provider = getProvider()
      if (!provider) return
      
      const bridge = new Contract(bridgeAddress, CROSS_CHAIN_BRIDGE_ABI, provider)
      const [status, _initiatedAt, _completedAt, attempts] = await bridge.getBridgeStatus(requestId)
      
      const statusMap: Record<number, string> = {
        0: '待处理',
        1: '处理中',
        2: '已完成',
        3: '失败'
      }
      
      setBridgeStatus(`状态: ${statusMap[Number(status)] || '未知'} | 尝试次数: ${attempts}`)
      
      // 如果失败且未达到最大重试次数，提供重试选项
      if (Number(status) === 3 && Number(attempts) < 3) {
        // 可以显示重试按钮
      }
    } catch (e) {
      console.error('查询状态失败:', e)
    }
  }, [bridgeAddress])
  
  // 监听跨链事件（状态监控）：定期轮询状态，避免 ethers v6 provider 事件类型不兼容
  useEffect(() => {
    if (!bridgeAddress || !lastRequestId) return

    const interval = setInterval(() => {
      checkBridgeStatus(lastRequestId)
    }, 10000)

    return () => clearInterval(interval)
  }, [bridgeAddress, lastRequestId, checkBridgeStatus])
  
  // 当参数变化时重新估算费用
  useEffect(() => {
    estimateFee()
  }, [estimateFee])

  // 执行跨链转移
  const handleBridge = useCallback(async () => {
    if (!account || !sourceChainId || !targetChainId || !tokenAddress || !amount) {
      setError('请填写完整信息')
      return
    }

    const amountBigInt = BigInt(Math.floor(parseFloat(amount) * 1e18))
    if (amountBigInt === 0n) {
      setError('请输入有效数量')
      return
    }

    setLoading(true)
    setError(null)

    try {
      await withSigner(async (signer) => {
        if (!bridgeAddress) throw new Error('桥接合约地址未配置')

        // 1. 检查并授权代币
        const token = new Contract(tokenAddress, ERC20_ABI, signer)
        const allowance = await token.allowance(account, bridgeAddress)
        
        if (allowance < amountBigInt) {
          const approveTx = await token.approve(bridgeAddress, amountBigInt)
          await approveTx.wait()
        }

        // 2. 估算费用
        const fee = await estimateFee()
        const feeAmount = fee || 0n

        // 3. 调用桥接
        const bridge = new Contract(bridgeAddress, CROSS_CHAIN_BRIDGE_ABI, signer)
        const options = '0x' // 默认选项
        
        // 获取 LayerZero EID
        const dstEid = LAYERZERO_EIDS[targetChainId]
        if (!dstEid) {
          throw new Error(`未找到链 ${targetChainId} 的 LayerZero EID`)
        }

        const tx = await bridge.bridgeToken(
          tokenAddress,
          amountBigInt,
          dstEid,
          options,
          { value: feeAmount }
        )

        const receipt = await tx.wait()
        
        // 错误处理优化：检查交易是否成功
        if (receipt.status !== 1) {
          throw new Error('交易失败')
        }
        
        // 从事件中获取requestId（状态监控）
        const bridgeInitiatedEvent = receipt.logs.find((log: any) => {
          try {
            const parsed = bridge.interface.parseLog(log)
            return parsed?.name === 'BridgeInitiated'
          } catch {
            return false
          }
        })
        
        if (bridgeInitiatedEvent) {
          const parsed = bridge.interface.parseLog(bridgeInitiatedEvent)
          const requestId = parsed?.args[0]
          if (requestId) {
            setLastRequestId(requestId)
            setBridgeStatus('跨链转移已发起，正在处理...')
          }
        }

        // 4. 刷新余额
        await fetchBalance()
        setAmount('')
        
        // 错误处理优化：更友好的提示
        if (!lastRequestId) {
          alert('跨链转移已发起，请等待确认')
        }
      })
    } catch (e: any) {
      setError(formatError(e))
    } finally {
      setLoading(false)
    }
  }, [account, sourceChainId, targetChainId, tokenAddress, amount, bridgeAddress, estimateFee, fetchBalance])

  const sourceChain = sourceChainId ? getChainConfig(sourceChainId) : null
  const targetChain = targetChainId ? getChainConfig(targetChainId) : null

  return (
    <div className="cross-chain-bridge">
      <h2>跨链桥接</h2>
      <p className="hint">在不同链之间转移资产</p>

      <ErrorDisplay error={error} onDismiss={() => setError(null)} className="bridge-error" />

      <div className="bridge-form">
        <div className="bridge-field">
          <label>源链</label>
          <select
            value={sourceChainId || ''}
            onChange={(e) => setSourceChainId(Number(e.target.value) || null)}
            disabled={loading}
          >
            <option value="">选择源链</option>
            {SUPPORTED_CHAINS.map((chain) => (
              <option key={chain.chainId} value={chain.chainId}>
                {chain.name}
              </option>
            ))}
          </select>
        </div>

        <div className="bridge-field">
          <label>目标链</label>
          <select
            value={targetChainId || ''}
            onChange={(e) => setTargetChainId(Number(e.target.value) || null)}
            disabled={loading}
          >
            <option value="">选择目标链</option>
            {SUPPORTED_CHAINS.filter((chain) => chain.chainId !== sourceChainId).map((chain) => (
              <option key={chain.chainId} value={chain.chainId}>
                {chain.name}
              </option>
            ))}
          </select>
        </div>

        <div className="bridge-field">
          <label>代币地址</label>
          <input
            type="text"
            value={tokenAddress}
            onChange={(e) => setTokenAddress(e.target.value)}
            placeholder="0x..."
            disabled={loading}
          />
        </div>

        <div className="bridge-field">
          <label>数量</label>
          <div className="bridge-amount-row">
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.0"
              step="0.000001"
              disabled={loading}
            />
            {balance !== '0' && (
              <button
                type="button"
                className="btn-max"
                onClick={() => setAmount(balance)}
                disabled={loading}
              >
                最大
              </button>
            )}
          </div>
          {balance !== '0' && <p className="hint">余额: {balance}</p>}
          {estimatedFee && <p className="hint">{estimatedFee}</p>}
        </div>

        <div className="bridge-field">
          <label>桥接合约地址（可选）</label>
          <input
            type="text"
            value={bridgeAddress}
            onChange={(e) => setBridgeAddress(e.target.value)}
            placeholder="0x...（留空使用默认）"
            disabled={loading}
          />
        </div>

        <button
          className="btn primary"
          onClick={handleBridge}
          disabled={loading || !account || !sourceChainId || !targetChainId || !tokenAddress || !amount}
        >
          {loading ? '处理中...' : '发起跨链转移'}
        </button>
      </div>

          {bridgeStatus && (
        <div className="bridge-status">
          <p>{bridgeStatus}</p>
        </div>
      )}
      
      {sourceChain && targetChain && (
        <div className="bridge-info">
          <h3>转移信息</h3>
          <div className="info-row">
            <span>源链:</span>
            <span>{sourceChain.name}</span>
          </div>
          <div className="info-row">
            <span>目标链:</span>
            <span>{targetChain.name}</span>
          </div>
          <div className="info-row">
            <span>代币:</span>
            <span className="mono">{tokenAddress || '未设置'}</span>
          </div>
        </div>
      )}
    </div>
  )
}
