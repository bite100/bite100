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
      await navigator.clipboard?.writeText(window.location.href ?? '')
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button
      type="button"
      className="btn secondary"
      onClick={handleCopy}
      style={{ fontSize: '0.8rem', padding: '0.35rem 0.6rem' }}
    >
      {copied ? '✓ 已复制' : '复制链接'}
    </button>
  )
}
