/**
 * 手机端连接引导：Deep Link 失败时的 fallback（清单 2.1）
 * 在手机端显示「复制链接」按钮，用户可粘贴到钱包 App 内置浏览器中打开
 */
import { useState, useMemo } from 'react'

function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 0 && window.innerWidth < 768)
}

export function MobileConnectHint() {
  const [copied, setCopied] = useState(false)
  const mobile = useMemo(() => isMobile(), [])

  if (!mobile) return null

  const handleCopy = async () => {
    try {
      const url = typeof window !== 'undefined' ? window.location.href : ''
      await navigator.clipboard?.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="mobile-connect-hint" style={{ marginTop: '0.25rem' }}>
      <button
        type="button"
        className="btn secondary"
        onClick={handleCopy}
        style={{ fontSize: '0.8rem', padding: '0.35rem 0.6rem' }}
      >
        {copied ? '✓ 已复制' : '复制链接，在钱包 App 内置浏览器中打开'}
      </button>
    </div>
  )
}
