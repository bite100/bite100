/**
 * 发币平台式连接：EIP-1193 Provider + eth_requestAccounts（EIP-1102）
 * 1. 同步 Trust/Phantom 到 window.ethereum
 * 2. 仅在用户点击后调用 eth_requestAccounts
 * 3. 连接状态持久化（localStorage）
 * 4. 连接超时处理
 */

import { syncMobileProvider } from '../walletConfig'

const win = typeof window !== 'undefined' ? (window as unknown as { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }) : null

const STORAGE_KEY_CONNECTOR = 'p2p_wallet_connector'
const STORAGE_KEY_ACCOUNT = 'p2p_wallet_account'
const REQUEST_TIMEOUT_MS = 30000 // 30 秒超时

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
 * 保存连接状态到 localStorage
 */
export function saveConnectionState(connectorType: string, account: string | null): void {
  try {
    if (typeof window === 'undefined') return
    if (account) {
      localStorage.setItem(STORAGE_KEY_CONNECTOR, connectorType)
      localStorage.setItem(STORAGE_KEY_ACCOUNT, account)
    } else {
      localStorage.removeItem(STORAGE_KEY_CONNECTOR)
      localStorage.removeItem(STORAGE_KEY_ACCOUNT)
    }
  } catch {
    // localStorage 可能不可用（隐私模式等）
  }
}

/**
 * 获取上次连接的账户（如果存在）
 */
export function getLastConnectedAccount(): string | null {
  try {
    if (typeof window === 'undefined') return null
    return localStorage.getItem(STORAGE_KEY_ACCOUNT)
  } catch {
    return null
  }
}

/**
 * 清除连接状态
 */
export function clearConnectionState(): void {
  try {
    if (typeof window === 'undefined') return
    localStorage.removeItem(STORAGE_KEY_CONNECTOR)
    localStorage.removeItem(STORAGE_KEY_ACCOUNT)
  } catch {
    // localStorage 可能不可用
  }
}

/**
 * 在用户点击时调用，请求账户访问（EIP-1102）。
 * 必须在用户手势（如 click）中调用，否则部分钱包会拒绝。
 * @returns 同意则 resolve 地址列表，拒绝则 reject（code 4001）
 */
export function requestAccountsOnUserGesture(): Promise<string[]> {
  const ethereum = getProviderAfterSync()
  if (!ethereum?.request) {
    return Promise.reject(new Error('未检测到钱包。请安装 MetaMask、Trust Wallet、Phantom 等钱包扩展，或在钱包 App 内置浏览器中打开本页。'))
  }

  // 添加超时处理
  return Promise.race([
    ethereum.request({ method: 'eth_requestAccounts', params: [] }) as Promise<string[]>,
    new Promise<string[]>((_, reject) => {
      setTimeout(() => {
        reject(new Error('连接超时。请检查钱包是否正常运行，或稍后重试。'))
      }, REQUEST_TIMEOUT_MS)
    }),
  ])
}
