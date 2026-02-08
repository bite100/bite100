import { useState, useEffect, useCallback } from 'react'
import { BrowserProvider } from 'ethers'
import { DEFAULT_CHAIN_ID, getChainConfig, isChainSupported } from '../config/chains'
import { debug } from '../utils'

export function useChain() {
  const [currentChainId, setCurrentChainId] = useState<number | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)

  // 初始化：检测当前链
  useEffect(() => {
    if (!window.ethereum) return

    const checkChain = async () => {
      try {
        const provider = new BrowserProvider(window.ethereum)
        const network = await provider.getNetwork()
        const chainId = Number(network.chainId)
        
        if (isChainSupported(chainId)) {
          setCurrentChainId(chainId)
        } else {
          // 如果不支持，使用默认链
          setCurrentChainId(DEFAULT_CHAIN_ID)
        }
      } catch (error) {
        debug.error('检测链失败:', error)
        setCurrentChainId(DEFAULT_CHAIN_ID)
      }
    }

    checkChain()

    // 监听链切换
    const handleChainChanged = (chainId: string) => {
      const id = parseInt(chainId, 16)
      if (isChainSupported(id)) {
        setCurrentChainId(id)
      }
    }

    window.ethereum.on('chainChanged', handleChainChanged)

    return () => {
      window.ethereum?.removeListener('chainChanged', handleChainChanged)
    }
  }, [])

  // 切换链
  const switchChain = useCallback(async (chainId: number) => {
    if (!window.ethereum) {
      throw new Error('请安装 MetaMask 或其他 Web3 钱包')
    }

    setIsConnecting(true)
    try {
      const provider = new BrowserProvider(window.ethereum)
      const currentNetwork = await provider.getNetwork()
      const currentChainId = Number(currentNetwork.chainId)

      if (currentChainId === chainId) {
        return
      }

      try {
        // 尝试切换链
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: `0x${chainId.toString(16)}` }],
        })
        setCurrentChainId(chainId)
      } catch (error: any) {
        // 如果链不存在，添加链
        if (error.code === 4902) {
          const config = getChainConfig(chainId)
          if (!config) {
            throw new Error(`链 ${chainId} 不支持`)
          }

          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: `0x${chainId.toString(16)}`,
              chainName: config.name,
              nativeCurrency: config.nativeCurrency,
              rpcUrls: [config.rpcUrl],
              blockExplorerUrls: config.blockExplorer ? [config.blockExplorer] : undefined,
            }],
          })
          setCurrentChainId(chainId)
        } else {
          throw error
        }
      }
    } finally {
      setIsConnecting(false)
    }
  }, [])

  const currentChain = currentChainId ? getChainConfig(currentChainId) : null

  return {
    currentChainId,
    currentChain,
    switchChain,
    isConnecting,
  }
}
