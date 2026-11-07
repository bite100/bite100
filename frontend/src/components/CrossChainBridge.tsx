import { useState, useCallback, useEffect } from 'react'
import { Contract, ZeroAddress } from 'ethers'
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
  'function bridgeToken(address token, uint256 amount, uint32 dstEid, bytes calldata options) payable returns (uint256 transferId, bytes32 guid)',
  'function quoteBridgeFee(address token, uint256 amount, uint32 dstEid, address user, bytes calldata options) view returns (uint256 nativeFee, uint256 lzTokenFee)',
  'function supportedTokens(address token) view returns (bool)',
  'function tokenMapping(uint32 dstEid, address token) view returns (address)',
  'function getBridgeStatus(bytes32 guid) view returns (uint8 status, uint256 transferId, uint256 initiatedAt, uint256 completedAt, uint256 attempts)',
  'function retryBridge(uint256 transferId, bytes calldata options) payable returns (bytes32 guid)',
  'event BridgeInitiated(bytes32 indexed guid, uint256 indexed transferId, address indexed user, address token, uint256 amount, uint32 dstEid)',
  'event BridgeStatusUpdated(uint256 indexed transferId, uint8 status, uint256 timestamp)',
] as const

// LayerZero EID（Endpoint ID）映射
const LAYERZERO_EIDS: Record<number, number> = {
  1: 30101,        // Ethereum Mainnet
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
  const [customBridgeAddress, setCustomBridgeAddress] = useState<string>('')
  // 桥合约地址默认取源链配置（config/chains.ts 的 crossChainBridge）；输入框填了自定义地址时以输入为准
  const configuredBridge = sourceChainId ? getChainConfig(sourceChainId)?.contracts.crossChainBridge : undefined
  const bridgeAddress =
    customBridgeAddress || (configuredBridge && configuredBridge !== ZeroAddress ? configuredBridge : '')
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

      const amountBigInt = BigInt(Math.floor(parseFloat(amount) * 1e18))
      const options = '0x' // 默认选项（合约侧对空 options 自动构造 type-3 执行选项）

      // 获取 LayerZero EID
      const dstEid = LAYERZERO_EIDS[targetChainId]
      if (!dstEid) {
        setEstimatedFee('目标链暂不支持跨链，无法估算费用')
        return null
      }

      const [nativeFee] = await bridge.quoteBridgeFee(
        tokenAddress,
        amountBigInt,
        dstEid,
        account || ZeroAddress,
        options
      )
      const feeFormatted = formatTokenAmount(nativeFee)
      setEstimatedFee(`预计跨链费用：${feeFormatted} ETH`)
      return nativeFee
    } catch (e: any) {
      console.error('估算费用失败:', e)
      setEstimatedFee('费用估算失败，请重试')
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
      const [status, _transferId, _initiatedAt, _completedAt, attempts] = await bridge.getBridgeStatus(requestId)
      
      const statusMap: Record<number, string> = {
        0: '待处理',
        1: '处理中',
        2: '已完成',
        3: '失败'
      }
      
      setBridgeStatus(`状态：${statusMap[Number(status)] || '未知'} · 已尝试 ${attempts} 次`)
      
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
      setError('请填写完整的跨链信息')
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
        if (!bridgeAddress) throw new Error('跨链桥合约地址未配置')

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
          throw new Error(`目标链 ${targetChainId} 暂不支持跨链（无 LayerZero EID 配置）`)
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
          throw new Error('跨链交易未成功')
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
            setBridgeStatus('跨链转移已发起，等待目标链确认…')
          }
        }

        // 4. 刷新余额
        await fetchBalance()
        setAmount('')
        
        // 错误处理优化：更友好的提示
        if (!lastRequestId) {
          alert('跨链转移已发起，请等待目标链确认')
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
      <h2>跨链桥</h2>
      <p className="hint">把代币从一条链转移到另一条链（通过 LayerZero），到达后可在目标链继续交易。步骤：① 选择源链与目标链；② 填入代币地址与数量；③ 查看预计费用后点「发起跨链转移」，在钱包中依次确认代币授权与转移。费用：跨链费用在发起时实时估算，以源链原生代币（如 ETH）支付，钱包里需留有足够原生代币；桥还会收取少量代币费用，从到账数量中扣除。到账时间：通常数分钟至十几分钟，发起后页面下方会持续显示转移状态。前提：已连接钱包，且钱包网络与所选源链一致。</p>

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
          {balance !== '0' && <p className="hint">可用余额：{balance}</p>}
          {estimatedFee && <p className="hint">{estimatedFee}</p>}
        </div>

        <div className="bridge-field">
          <label>跨链桥合约地址（可选）</label>
          <input
            type="text"
            value={customBridgeAddress}
            onChange={(e) => setCustomBridgeAddress(e.target.value)}
            placeholder="0x...（留空使用默认）"
            disabled={loading}
          />
        </div>

        <button
          className="btn primary"
          onClick={handleBridge}
          disabled={loading || !account || !sourceChainId || !targetChainId || !tokenAddress || !amount}
        >
          {loading ? '处理中…' : '发起跨链转移'}
        </button>
      </div>

          {bridgeStatus && (
        <div className="bridge-status">
          <p>{bridgeStatus}</p>
        </div>
      )}

      <p className="hint">注意：发起后请勿重复提交同一笔转移。若状态长时间停留在「处理中」，说明跨链消息仍在传递，请耐心等待；若显示「失败」或长时间未到账，可凭源链交易哈希在区块浏览器或 LayerZero Scan 查询进度，确认原转移未成功后再重新发起。</p>
      
      {sourceChain && targetChain && (
        <div className="bridge-info">
          <h3>本次转移</h3>
          <div className="info-row">
            <span>源链：</span>
            <span>{sourceChain.name}</span>
          </div>
          <div className="info-row">
            <span>目标链：</span>
            <span>{targetChain.name}</span>
          </div>
          <div className="info-row">
            <span>代币：</span>
            <span className="mono">{tokenAddress || '未设置'}</span>
          </div>
        </div>
      )}
    </div>
  )
}
