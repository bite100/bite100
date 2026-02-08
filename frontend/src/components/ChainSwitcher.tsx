import { useState, useEffect } from 'react'
import { BrowserProvider } from 'ethers'
import { SUPPORTED_CHAINS, getChainConfig, getAddChainParams, isChainSupported, DEFAULT_CHAIN_ID } from '../config/chains'
import './ChainSwitcher.css'

interface ChainSwitcherProps {
  currentChainId: number | null
  onChainChange: (chainId: number) => void
}

export function ChainSwitcher({ currentChainId, onChainChange }: ChainSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [switching, setSwitching] = useState(false)

  const currentChain = currentChainId ? getChainConfig(currentChainId) : null

  const switchChain = async (chainId: number) => {
    if (!window.ethereum) {
      alert('请安装 MetaMask 或其他 Web3 钱包')
      return
    }

    setSwitching(true)
    try {
      const provider = new BrowserProvider(window.ethereum)
      const currentChainId = await provider.getNetwork().then(n => Number(n.chainId))

      // 如果已经是目标链，直接返回
      if (currentChainId === chainId) {
        setSwitching(false)
        setIsOpen(false)
        return
      }

      try {
        // 尝试切换链
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: `0x${chainId.toString(16)}` }],
        })
        onChainChange(chainId)
      } catch (error: any) {
        // 如果链不存在，添加链
        if (error.code === 4902) {
          const params = getAddChainParams(chainId)
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [params],
          })
          onChainChange(chainId)
        } else {
          throw error
        }
      }
    } catch (error: any) {
      console.error('切换链失败:', error)
      alert(`切换链失败: ${error.message || '未知错误'}`)
    } finally {
      setSwitching(false)
      setIsOpen(false)
    }
  }

  return (
    <div className="chain-switcher">
      <button
        className="chain-switcher-button"
        onClick={() => setIsOpen(!isOpen)}
        disabled={switching}
      >
        {switching ? (
          <span>切换中...</span>
        ) : currentChain ? (
          <>
            <span className="chain-name">{currentChain.name}</span>
            <span className="chain-indicator">▼</span>
          </>
        ) : (
          <span>选择链</span>
        )}
      </button>

      {isOpen && (
        <>
          <div className="chain-switcher-overlay" onClick={() => setIsOpen(false)} />
          <div className="chain-switcher-menu">
            <div className="chain-switcher-header">
              <h3>选择网络</h3>
              <button className="chain-switcher-close" onClick={() => setIsOpen(false)}>×</button>
            </div>
            <div className="chain-switcher-list">
              {SUPPORTED_CHAINS.map((chain) => {
                const isActive = currentChainId === chain.chainId
                const isDeployed = chain.contracts.vault !== '0x0000000000000000000000000000000000000000'
                
                return (
                  <button
                    key={chain.chainId}
                    className={`chain-switcher-item ${isActive ? 'active' : ''} ${!isDeployed ? 'not-deployed' : ''}`}
                    onClick={() => switchChain(chain.chainId)}
                    disabled={switching || isActive}
                  >
                    <div className="chain-item-content">
                      <span className="chain-item-name">{chain.name}</span>
                      {isActive && <span className="chain-item-badge">当前</span>}
                      {!isDeployed && <span className="chain-item-badge warning">待部署</span>}
                    </div>
                    {chain.blockExplorer && (
                      <a
                        href={chain.blockExplorer}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="chain-item-explorer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        🔗
                      </a>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
