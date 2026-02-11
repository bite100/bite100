/**
 * 钱包 Deep Link：点击连接按钮后跳转到钱包 App 内置浏览器
 * MetaMask: https://link.metamask.io/dapp/{domain} (仅域名，完整 URL 会 404)
 * Trust Wallet: https://link.trustwallet.com/open_url?coin_id=60&url={完整URL}
 * Phantom: https://phantom.app/ul/v1/browse?url={完整URL} (主要 Solana，EVM 可能不支持)
 */

function getCurrentUrl(): string {
  if (typeof window === 'undefined') return ''
  return encodeURIComponent(window.location.href)
}

function getCurrentDomain(): string {
  if (typeof window === 'undefined') return ''
  // MetaMask 只用域名（hostname），不要协议和路径，否则 404
  return window.location.hostname
}

const DEEP_LINKS: Record<string, () => string> = {
  metamask: () => `https://link.metamask.io/dapp/${getCurrentDomain()}`,
  trust: () => `https://link.trustwallet.com/open_url?coin_id=60&url=${getCurrentUrl()}`,
  phantom: () => `https://phantom.app/ul/v1/browse?url=${getCurrentUrl()}`,
}

/**
 * 尝试用 deep link 打开钱包 App，失败则返回 false
 */
export function tryOpenWalletApp(wallet: 'metamask' | 'trust' | 'phantom'): boolean {
  const getLink = DEEP_LINKS[wallet]
  if (!getLink) return false
  const link = getLink()
  try {
    // 使用 window.location 跳转（更可靠）
    window.location.href = link
    return true
  } catch {
    try {
      // fallback: 创建 a 标签点击
      const a = document.createElement('a')
      a.href = link
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      document.body.appendChild(a)
      a.click()
      setTimeout(() => document.body.removeChild(a), 100)
      return true
    } catch {
      return false
    }
  }
}

/**
 * 手机浏览器：尝试打开 MetaMask，失败则尝试 Trust，再失败返回 false
 */
export function tryOpenAnyWalletApp(): boolean {
  return tryOpenWalletApp('metamask') || tryOpenWalletApp('trust') || tryOpenWalletApp('phantom')
}
