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
    expect(c!.contracts.settlement).toBe('0x5697F7B2178352eB391e29fc2c5681Dea864C1d9')
    expect(c!.contracts.vault).toBe('0x836cEFF0140aB66D8DD984ECb18765736BA121e9')
    expect(c!.contracts.crossChainBridge).toBe('0x7a0eCbc2Ffca2F8f7A1505Fa65e7E4759bE33d50')
  })

  it('returns Base Sepolia config for chainId 84532', () => {
    const c = getChainConfig(84532)
    expect(c).not.toBeNull()
    expect(c!.chainId).toBe(84532)
    expect(c!.name).toBe('Base Sepolia')
    expect(c!.contracts.settlement).toBe('0x1021C7116cCE59f9c85683d6f1b5aD2215795949')
    expect(c!.contracts.vault).toBe('0x295F5529F5BfA4cA39290f395b1feF7EA637f5D3')
    expect(c!.contracts.crossChainBridge).toBe('0xA7722A0ba7F2DA1d4D67D5191222C5e4c3835dBB')
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

describe('第十九轮三桥配置（LayerZero / CCIP / Wormhole）', () => {
  const ADDR = /^0x[0-9a-fA-F]{40}$/
  const ZERO = '0x0000000000000000000000000000000000000000'

  it('Sepolia 三桥地址齐全且非零', () => {
    const c = getChainConfig(11155111)!
    // LayerZero（第十六轮既有通道不得被覆盖）
    expect(c.contracts.crossChainBridge).toBe('0x7a0eCbc2Ffca2F8f7A1505Fa65e7E4759bE33d50')
    // CCIP
    expect(c.ccip).toBeDefined()
    expect(c.ccip!.router).toBe('0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59')
    expect(c.ccip!.tokenPool).toBe('0x68Bf313360021DcF4E359aD18c4506f622A3666d')
    expect(c.ccip!.chainSelector).toBe('16015286601757825753')
    // Wormhole NTT
    expect(c.wormhole).toBeDefined()
    expect(c.wormhole!.nttManager).toBe('0x5a6Da05af0d9eF61BA85f610556357bEb1DC57D1')
    expect(c.wormhole!.nttTransceiver).toBe('0x1bFb42E93F5860C76ef0E100E063083357b93C8A')
    expect(c.wormhole!.wormholeChainId).toBe(10002)
    // wTKA
    expect(c.contracts.wrappedToken).toBe('0x03ED8203236Bb5409caA6330fDCd16559C914b9a')
  })

  it('Base Sepolia 三桥地址齐全且非零', () => {
    const c = getChainConfig(84532)!
    expect(c.contracts.crossChainBridge).toBe('0xA7722A0ba7F2DA1d4D67D5191222C5e4c3835dBB')
    expect(c.ccip).toBeDefined()
    expect(c.ccip!.router).toBe('0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93')
    expect(c.ccip!.tokenPool).toBe('0x93a4af54d7cD8aF7c9aEF50D3Dd3977bA1Dde28E')
    expect(c.ccip!.chainSelector).toBe('10344971235874465080')
    expect(c.wormhole).toBeDefined()
    expect(c.wormhole!.nttManager).toBe('0x9E45CCB3A5fef0E72bB8e97450b7FcF97EFC4d72')
    expect(c.wormhole!.nttTransceiver).toBe('0x74da43aF57134AFa610ADB8fdA1031594b9a494f')
    expect(c.wormhole!.wormholeChainId).toBe(10004)
    expect(c.contracts.wrappedToken).toBe('0x346DE29B7fEe95F44A5b5385e87182F031E8E1B5')
  })

  it('双测试网三桥地址均为合法非零地址，且 CCIP 选择器以字符串保存不丢精度', () => {
    for (const id of [11155111, 84532]) {
      const c = getChainConfig(id)!
      const addrs = [
        c.contracts.crossChainBridge,
        c.contracts.wrappedToken!,
        c.ccip!.router,
        c.ccip!.tokenPool,
        c.ccip!.tokenAdminRegistry,
        c.wormhole!.coreBridge,
        c.wormhole!.nttManager,
        c.wormhole!.nttTransceiver,
      ]
      for (const a of addrs) {
        expect(a).toMatch(ADDR)
        expect(a).not.toBe(ZERO)
      }
      // uint64 选择器超过 JS 安全整数范围，必须是字符串且能无损转 BigInt
      expect(typeof c.ccip!.chainSelector).toBe('string')
      expect(BigInt(c.ccip!.chainSelector).toString()).toBe(c.ccip!.chainSelector)
    }
  })

  it('主网配置暂无 CCIP / Wormhole（未部署不得伪造）', () => {
    const c = getChainConfig(1)!
    expect(c.ccip).toBeUndefined()
    expect(c.wormhole).toBeUndefined()
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
