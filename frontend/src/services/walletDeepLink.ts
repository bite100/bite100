/**
 * 钱包 Deep Link：点击连接按钮后跳转到钱包 App 内置浏览器
 * 支持主流钱包：MetaMask、Trust、Phantom、Coinbase、imToken、OKX、Bitget、TokenPocket 等。
 *
 * 404 原因说明：
 * - 若站点在子路径（如 GitHub Pages: xxx.github.io/repo/），只传域名时钱包会打开根路径即 404。
 * - MetaMask 子路径时传完整 URL（编码）；根路径传域名。
 */

function getCurrentUrl(): string {
  if (typeof window === 'undefined') return ''
  return encodeURIComponent(window.location.href)
}

function getCurrentUrlEncodedForPath(): string {
  if (typeof window === 'undefined') return ''
  return encodeURIComponent(window.location.href)
}

function getCurrentDomain(): string {
  if (typeof window === 'undefined') return ''
  return window.location.hostname
}

/** MetaMask dapp 参数：子路径用完整 URL 防 404，根路径用域名 */
function getMetaMaskDappParam(): string {
  if (typeof window === 'undefined') return ''
  const { pathname } = window.location
  const isRoot = pathname === '/' || pathname === ''
  return isRoot ? getCurrentDomain() : getCurrentUrlEncodedForPath()
}

const DEEP_LINKS: Record<string, () => string> = {
  metamask: () => `https://link.metamask.io/dapp/${getMetaMaskDappParam()}`,
  trust: () => `https://link.trustwallet.com/open_url?coin_id=60&url=${getCurrentUrl()}`,
  phantom: () => `https://phantom.app/ul/v1/browse?url=${getCurrentUrl()}`,
  coinbase: () => `https://go.cb-w.com/dapp?url=${getCurrentUrl()}`,
  // imToken Universal Link
  imtoken: () => `https://connect.token.im/link/navigate/DappView?url=${getCurrentUrl()}`,
  // OKX: 先跳转 download 页，deeplink 里带 dappUrl
  okx: () =>
    `https://web3.okx.com/download?deeplink=${encodeURIComponent(
      `okx://wallet/dapp/url?dappUrl=${getCurrentUrl()}`
    )}`,
  // Bitget (BitKeep) BKConnect
  bitget: () => `https://bkcode.vip?action=dapp&url=${getCurrentUrl()}`,
  // TokenPocket 打开 dApp 浏览器
  tokenpocket: () => `https://tokenpocket.pro/dapp/open?url=${getCurrentUrl()}`,
  // Rainbow 主要走 WalletConnect，可选打开 App
  rainbow: () => `https://rnbwapp.com/dapp?url=${getCurrentUrl()}`,
  // OneKey 打开 dApp
  onekey: () => `https://app.onekey.so/dapp?url=${getCurrentUrl()}`,
  // SafePal 打开 dApp
  safepal: () => `https://link.safepal.io/dapp?url=${getCurrentUrl()}`,
  // Rabby 移动端
  rabby: () => `https://rabby.io/dapp?url=${getCurrentUrl()}`,
}

/** 支持深链接打开的钱包 key */
export type WalletDeepLinkKey =
  | 'metamask'
  | 'trust'
  | 'phantom'
  | 'coinbase'
  | 'imtoken'
  | 'okx'
  | 'bitget'
  | 'tokenpocket'
  | 'rainbow'
  | 'onekey'
  | 'safepal'
  | 'rabby'

/** 按优先级尝试的钱包顺序（主流优先） */
const WALLET_PRIORITY: WalletDeepLinkKey[] = [
  'metamask',
  'trust',
  'imtoken',
  'okx',
  'tokenpocket',
  'bitget',
  'coinbase',
  'phantom',
  'onekey',
  'safepal',
  'rabby',
  'rainbow',
]

/**
 * 检测是否在钱包 App 内置浏览器中
 */
export function isInWalletBrowser(): boolean {
  if (typeof window === 'undefined') return false
  const ua = navigator.userAgent.toLowerCase()
  return (
    ua.includes('metamask') ||
    ua.includes('trust') ||
    ua.includes('phantom') ||
    ua.includes('coinbase') ||
    ua.includes('rainbow') ||
    ua.includes('imtoken') ||
    ua.includes('tokenpocket') ||
    ua.includes('okx') ||
    ua.includes('bitget') ||
    ua.includes('bitkeep') ||
    ua.includes('onekey') ||
    ua.includes('safepal') ||
    ua.includes('rabby') ||
    ua.includes('wallet')
  )
}

/**
 * 尝试用 deep link 打开指定钱包 App，失败则返回 false
 */
export function tryOpenWalletApp(wallet: WalletDeepLinkKey): boolean {
  if (isInWalletBrowser()) return false

  const getLink = DEEP_LINKS[wallet]
  if (!getLink) return false
  const link = getLink()

  try {
    window.location.href = link
    return true
  } catch {
    try {
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
 * 手机浏览器：按优先级依次尝试用深链接打开主流钱包 App
 */
export function tryOpenAnyWalletApp(): boolean {
  if (isInWalletBrowser()) return false

  for (const w of WALLET_PRIORITY) {
    if (tryOpenWalletApp(w)) return true
  }
  return false
}
