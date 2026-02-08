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

  return (
    <div className={`error-display ${isNetworkError ? 'network-error' : ''} ${className}`}>
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
  )
}
