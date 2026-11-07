/**
 * 做市金库链上读取（第 31 轮）：全部数字来自第 30 轮现行 MakerVault 合约
 * （地址登记在 chains.ts contracts.makerVault）；读不到就返回 null，界面不显示数字、禁止编造。
 * 口径与 makerVaultMath 一致：NAV/可提份额/挂单占用都由这里的原始读数组合。
 * totalAssets() 在喂价过期且金库持有基础币时会回滚（合约 fail-closed），
 * 因此读取失败是预期内的诚实状态，界面按「暂时读不到」处理。
 */
import { useEffect, useState } from 'react'
import { Contract, JsonRpcProvider, formatUnits } from 'ethers'
import type { ChainConfig } from '../../config/chains'
import { VAULT_ABI, ERC20_ABI } from '../../config'
import { deriveMakerVaultFigures, type MakerVaultDerived } from './makerVaultMath'

export const MAKERVAULT_ABI = [
  'function asset() view returns (address)',
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function baseToken() view returns (address)',
  'function latestPrice() view returns (int256 price, uint256 updatedAt, bool fresh)',
  'function paused() view returns (bool)',
  'function deposit(uint256, address) returns (uint256)',
  'function redeem(uint256, address, address) returns (uint256)',
] as const

export interface MakerVaultData {
  address: string
  /** 计价资产符号（ERC-4626 asset，本站为 USDT） */
  assetSymbol: string
  totalAssets: number
  totalShares: number
  myShares: number
  paused: boolean
  derived: MakerVaultDerived
}

const toNum = (v: bigint) => Number(formatUnits(v, 18))

export async function readMakerVaultData(
  chainConfig: ChainConfig,
  account: string | null,
): Promise<MakerVaultData | null> {
  const address = chainConfig.contracts.makerVault
  if (!address) return null
  const provider = new JsonRpcProvider(chainConfig.rpcUrl)
  const mv = new Contract(address, MAKERVAULT_ABI, provider)
  const vault = new Contract(chainConfig.contracts.vault, VAULT_ABI, provider)

  const [assetAddr, totalAssetsWei, totalSupplyWei, paused] = await Promise.all([
    mv.asset() as Promise<string>,
    mv.totalAssets() as Promise<bigint>,
    mv.totalSupply() as Promise<bigint>,
    mv.paused() as Promise<boolean>,
  ])
  const assetToken = new Contract(assetAddr, ERC20_ABI, provider)
  const assetSymbol = ((await assetToken.symbol().catch(() => 'USDT')) as string) || 'USDT'

  const mySharesWei = account ? ((await mv.balanceOf(account)) as bigint) : 0n

  // 流动计价资产：金库自有 USDT + 交易 Vault 中金库名下的可用额
  const [ownQuoteWei, availQuoteWei, lockedQuoteWei] = await Promise.all([
    assetToken.balanceOf(address) as Promise<bigint>,
    vault.availableBalance(assetAddr, address).catch(() => 0n) as Promise<bigint>,
    vault.locked(address, assetAddr).catch(() => 0n) as Promise<bigint>,
  ])

  // 挂单占用：计价侧锁定 + 基础币锁定按金库自己的喂价折算（喂价不新鲜则只计计价侧）
  let lockedQuoteValueWei = lockedQuoteWei
  try {
    const baseAddr = (await mv.baseToken()) as string
    const lockedBaseWei = (await vault.locked(address, baseAddr).catch(() => 0n)) as bigint
    if (lockedBaseWei > 0n) {
      const [price, , fresh] = (await mv.latestPrice()) as [bigint, bigint, boolean]
      if (fresh && price > 0n) {
        lockedQuoteValueWei += (lockedBaseWei * price) / 100_000_000n
      }
    }
  } catch {
    // baseToken/latestPrice 读不到时按仅计价侧锁定呈现，不编造基础币折算
  }

  const totalAssets = toNum(totalAssetsWei)
  const totalShares = toNum(totalSupplyWei)
  const myShares = toNum(mySharesWei)
  const liquidQuote = toNum(ownQuoteWei + availQuoteWei)
  const lockedQuoteValue = toNum(lockedQuoteValueWei)

  return {
    address,
    assetSymbol,
    totalAssets,
    totalShares,
    myShares,
    paused,
    derived: deriveMakerVaultFigures({
      totalAssets,
      totalShares,
      myShares,
      liquidQuote,
      lockedQuoteValue,
    }),
  }
}

export function useMakerVaultData(
  chainConfig: ChainConfig | null,
  account: string | null,
  refreshTick = 0,
): { data: MakerVaultData | null; loading: boolean; failed: boolean } {
  const [state, setState] = useState<{ data: MakerVaultData | null; loading: boolean; failed: boolean }>({
    data: null,
    loading: true,
    failed: false,
  })

  useEffect(() => {
    if (!chainConfig || !chainConfig.contracts.makerVault) {
      setState({ data: null, loading: false, failed: false })
      return
    }
    let cancelled = false
    setState((s) => ({ ...s, loading: true }))
    readMakerVaultData(chainConfig, account)
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, failed: data === null })
      })
      .catch(() => {
        if (!cancelled) setState({ data: null, loading: false, failed: true })
      })
    return () => {
      cancelled = true
    }
  }, [chainConfig, account, refreshTick])

  return state
}

/* ---------- NAV 本地采样（快照线；与估值快照同一模式） ---------- */

export interface NavSample {
  t: number
  nav: number
}

const NAV_KEY_PREFIX = 'b100.mvNavSamples.'

export function loadNavSamples(chainId: number, address: string): NavSample[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(NAV_KEY_PREFIX + chainId + '.' + address) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (s): s is NavSample =>
          typeof s === 'object' && s !== null &&
          typeof (s as NavSample).t === 'number' &&
          typeof (s as NavSample).nav === 'number',
      )
      .sort((a, b) => a.t - b.t)
  } catch {
    return []
  }
}

export function recordNavSample(chainId: number, address: string, nav: number, now: number): NavSample[] {
  const samples = loadNavSamples(chainId, address).filter((s) => now - s.t <= 30 * 24 * 3600 * 1000)
  const last = samples[samples.length - 1]
  if (last && now - last.t < 3600 * 1000 && Math.abs(last.nav - nav) < 1e-12) return samples
  const next = [...samples, { t: now, nav }].slice(-200)
  try {
    localStorage.setItem(NAV_KEY_PREFIX + chainId + '.' + address, JSON.stringify(next))
  } catch {
    // 存储不可用时不采样，快照行按规则整行隐藏
  }
  return next
}
