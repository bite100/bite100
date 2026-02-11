import { formatError } from '../utils'
import './ErrorDisplay.css'

interface ErrorDisplayProps {
  error: unknown
  onRetry?: () => void
  onDismiss?: () => void
  className?: string
}

export function ErrorDisplay({ error, onRetry, onDismiss, className = '' }: ErrorDisplayProps) {
  if (!error) return null

  const message = formatError(error)
  const isNetworkError = typeof message === 'string' && (
    message.includes('网络') || 
    message.includes('离线') || 
    message.includes('fetch failed') ||
    message.includes('timeout')
  )

  const connectHint = typeof message === 'string' && (
    message.includes('网络') || message.includes('超时') || message.includes('钱包') || message.includes('连接')
  )

  return (
    <div className={`error-display-wrap ${className}`}>
      <div className={`error-display ${isNetworkError ? 'network-error' : ''}`}>
        <div className="error-content">
          <span className="error-icon">⚠️</span>
          <span className="error-message">{message}</span>
        </div>
        {(onRetry || onDismiss) && (
          <div className="error-actions">
          {onRetry && (
            <button type="button" className="btn-retry" onClick={onRetry}>
              重试
            </button>
          )}
          {onDismiss && (
            <button type="button" className="btn-dismiss" onClick={onDismiss}>
              ✕
            </button>
          )}
          </div>
        )}
      </div>
      {connectHint && (
        <p className="error-hint">若持续失败，请刷新页面或尝试在 MetaMask、Trust 等钱包 App 内置浏览器中打开</p>
      )}
    </div>
  )
}
