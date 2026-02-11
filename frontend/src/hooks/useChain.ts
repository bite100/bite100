import { useState, useEffect, useCallback } from 'react'
import { BrowserProvider } from 'ethers'
import { DEFAULT_CHAIN_ID, getChainConfig, isChainSupported } from '../config/chains'
import { getEthereum, debug } from '../utils'

export function useChain() {
  const [currentChainId, setCurrentChainId] = useState<number | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)

  useEffect(() => {
    const ethereum = getEthereum()
    if (!ethereum) return

    const checkChain = async () => {
      try {
        const provider = new BrowserProvider(ethereum)
        const network = await provider.getNetwork()
        const chainId = Number(network.chainId)
        setCurrentChainId(isChainSupported(chainId) ? chainId : DEFAULT_CHAIN_ID)
      } catch (error) {
        debug.error('检测链失败:', error)
        setCurrentChainId(DEFAULT_CHAIN_ID)
      }
    }

    checkChain()

    const handleChainChanged = (chainId: string) => {
      const id = parseInt(chainId, 16)
      if (isChainSupported(id)) setCurrentChainId(id)
    }

    const provider = ethereum as { on?: (e: string, cb: (v: string) => void) => void; removeListener?: (e: string, cb: (v: string) => void) => void }
    if (typeof provider.on === 'function') {
      provider.on('chainChanged', handleChainChanged)
      return () => {
        if (typeof provider.removeListener === 'function') {
          provider.removeListener('chainChanged', handleChainChanged)
        }
      }
    }
  }, [])

  const switchChain = useCallback(async (chainId: number) => {
    const ethereum = getEthereum()
    if (!ethereum) {
      throw new Error('请安装 MetaMask、Trust 等钱包，或在钱包 App 内置浏览器中打开本页')
    }

    setIsConnecting(true)
    try {
      const provider = new BrowserProvider(ethereum)
      const currentNetwork = await provider.getNetwork()
      const currentChainId = Number(currentNetwork.chainId)
      if (currentChainId === chainId) return

      try {
        await ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: `0x${chainId.toString(16)}` }],
        })
        setCurrentChainId(chainId)
      } catch (err: unknown) {
        const code = err && typeof err === 'object' && 'code' in err ? (err as { code: number }).code : undefined
        if (code === 4902) {
          const config = getChainConfig(chainId)
          if (!config) throw new Error(`链 ${chainId} 不支持`)
          await ethereum.request({
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
          throw err
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
