/**
 * 多链配置纯函数单元测试
 */
import { describe, it, expect } from 'vitest'
import {
  getChainConfig,
  isChainSupported,
  getAddChainParams,
  DEFAULT_CHAIN_ID,
  CHAIN_CONFIGS,
  type ChainConfig,
} from './chains'

describe('getChainConfig', () => {
  it('returns Sepolia config for chainId 11155111', () => {
    const c = getChainConfig(11155111)
    expect(c).not.toBeNull()
    expect(c!.chainId).toBe(11155111)
    expect(c!.name).toBe('Sepolia')
    expect(c!.contracts.settlement).toBe('0x929ceb054B86Bf222eb94Df7b75aDa4fD22A538A')
  })

  it('returns Base Sepolia config for chainId 84532', () => {
    const c = getChainConfig(84532)
    expect(c).not.toBeNull()
    expect(c!.chainId).toBe(84532)
    expect(c!.name).toBe('Base Sepolia')
    expect(c!.contracts.settlement).toBe('0x3F9F29A6Ff7F706Bd769da3f0F4b3dCe70371D4c')
    expect(c!.contracts.vault).toBe('0xd09E808D0978bdD06738a5dAfBd3c0a286aE3Fb2')
  })

  it('returns Ethereum mainnet for chainId 1', () => {
    const c = getChainConfig(1)
    expect(c).not.toBeNull()
    expect(c!.chainId).toBe(1)
    expect(c!.name).toBe('Ethereum')
  })

  it('returns null for unknown chainId', () => {
    expect(getChainConfig(999)).toBeNull()
    expect(getChainConfig(0)).toBeNull()
  })
})

describe('isChainSupported', () => {
  it('returns true for Sepolia, Mainnet, Polygon, Base, Arbitrum, Optimism, BSC', () => {
    expect(isChainSupported(11155111)).toBe(true)
    expect(isChainSupported(1)).toBe(true)
    expect(isChainSupported(137)).toBe(true)
    expect(isChainSupported(8453)).toBe(true)
    expect(isChainSupported(42161)).toBe(true)
    expect(isChainSupported(10)).toBe(true)
    expect(isChainSupported(56)).toBe(true)
  })

  it('returns false for unknown chainId', () => {
    expect(isChainSupported(999)).toBe(false)
  })
})

describe('getAddChainParams', () => {
  it('returns MetaMask add chain params for Sepolia', () => {
    const params = getAddChainParams(11155111)
    expect(params.chainId).toBe('0xaa36a7')
    expect(params.chainName).toBe('Sepolia')
    expect(params.nativeCurrency.symbol).toBe('ETH')
    expect(params.rpcUrls).toEqual(['https://ethereum-sepolia.publicnode.com'])
    expect(params.blockExplorerUrls).toEqual(['https://sepolia.etherscan.io'])
  })

  it('throws for unsupported chainId', () => {
    expect(() => getAddChainParams(999)).toThrow('not supported')
  })
})

describe('DEFAULT_CHAIN_ID', () => {
  it('is Sepolia', () => {
    expect(DEFAULT_CHAIN_ID).toBe(11155111)
  })
})

describe('CHAIN_CONFIGS', () => {
  it('has expected chainIds and each config has required fields', () => {
    const requiredKeys: (keyof ChainConfig)[] = [
      'chainId', 'name', 'rpcUrl', 'nativeCurrency', 'contracts',
    ]
    for (const [id, config] of Object.entries(CHAIN_CONFIGS)) {
      expect(Number(id)).toBe(config.chainId)
      for (const k of requiredKeys) {
        expect(config).toHaveProperty(k)
      }
      expect(config.contracts).toHaveProperty('vault')
      expect(config.contracts).toHaveProperty('settlement')
    }
  })
})
