import { useP2P } from '../contexts/P2PContext'
import './P2PStatus.css'

export function P2PStatus() {
  const { isConnected, peerId, peerCount } = useP2P()

  return (
    <div className="p2p-status">
      <div className={`status-indicator ${isConnected ? 'connected' : 'disconnected'}`}>
        <span className="status-dot"></span>
        <span className="status-text">
          {isConnected ? 'P2P 已连接' : 'P2P 断开'}
        </span>
      </div>
      
      {isConnected && (
        <>
          <div className="peer-count">
            <span className="label">节点数:</span>
            <span className="value">{peerCount}</span>
          </div>
          
          <div className="peer-id" title={peerId || ''}>
            <span className="label">节点 ID:</span>
            <span className="value">{peerId?.slice(0, 8)}...</span>
          </div>
        </>
      )}
    </div>
  )
}
