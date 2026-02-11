/**
 * 发币平台式连接：EIP-1193 Provider + eth_requestAccounts（EIP-1102）
 * 1. 同步 Trust/Phantom 到 window.ethereum
 * 2. 仅在用户点击后调用 eth_requestAccounts
 */

import { syncMobileProvider } from '../walletConfig'

const win = typeof window !== 'undefined' ? (window as unknown as { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }) : null

/** 连接前同步一次 provider，返回当前 window.ethereum */
export function getProviderAfterSync(): { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } | null {
  syncMobileProvider()
  const eth = win?.ethereum
  return eth && typeof (eth as { request?: unknown }).request === 'function' ? (eth as { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }) : null
}

/** 是否已有注入的 provider（同步后） */
export function hasInjectedProvider(): boolean {
  return !!getProviderAfterSync()
}

/**
 * 在用户点击时调用，请求账户访问（EIP-1102）。
 * 必须在用户手势（如 click）中调用，否则部分钱包会拒绝。
 * @returns 同意则 resolve 地址列表，拒绝则 reject（code 4001）
 */
export function requestAccountsOnUserGesture(): Promise<string[]> {
  const ethereum = getProviderAfterSync()
  if (!ethereum?.request) return Promise.reject(new Error('未检测到钱包'))
  return ethereum.request({ method: 'eth_requestAccounts', params: [] }) as Promise<string[]>
}
