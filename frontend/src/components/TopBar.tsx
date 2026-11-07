/**
 * 第 31 轮顶栏：48px 固定瘦顶栏——品牌字标 + 当前栏目名 | 链 chip + 钱包 chip。
 * 未连接时钱包 chip 显示「连接钱包」，点击进入资产页的连接空态完成连接
 * （完整连接说明在各页 ConnectGate 里，顶栏不塞多按钮连接器）。
 */
import { ChainSwitcher } from './ChainSwitcher'
import './TopBar.css'

interface TopBarProps {
  title: string
  chainId: number | null
  onChainChange: (chainId: number) => void
  account: string | null
  onWalletClick: () => void
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function TopBar({ title, chainId, onChainChange, account, onWalletClick }: TopBarProps) {
  return (
    <header className="topbar31">
      <span className="topbar31-mark" aria-hidden="true">
        B
      </span>
      <span className="topbar31-title">{title}</span>
      <span className="topbar31-spacer" />
      <span className="topbar31-chain">
        <ChainSwitcher currentChainId={chainId} onChainChange={onChainChange} />
      </span>
      <button type="button" className="topbar31-wallet" onClick={onWalletClick}>
        {account ? <span className="num">{shortAddress(account)}</span> : '连接钱包'}
      </button>
    </header>
  )
}
