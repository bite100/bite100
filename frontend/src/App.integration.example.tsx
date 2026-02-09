// @ts-nocheck
import React, { useEffect, useState } from 'react'
import { ethers } from 'ethers'
import { P2PProvider, useP2P } from './contexts/P2PContext'
import { chainSyncService } from './services/chainSync'
import { useTrades } from './hooks/useTrades'
import { useMyOrders } from './hooks/useMyOrders'
import { useSettleOnMatch } from './hooks/useSettleOnMatch'
import { DatabaseManager } from './p2p/storage'
import { SETTLEMENT_ADDRESS, RPC_URL } from './config'

/**
 * 完整的分层存储集成示例
 *
 * 广播订单 → IndexedDB pending → 收到订单撮合 → 广播 Match + 尝试 settleTrade
 * App 启动加载 pending 到 UI/内存；关浏览器重开验证恢复；过期清理（expiry 过滤）
 */

function AppContent() {
  const { isConnected, peerId, peerCount, storageEnabled } = useP2P()
  const [provider, setProvider] = useState<ethers.Provider | null>(null)
  const [signer, setSigner] = useState<ethers.Signer | null>(null)
  const [userAddress, setUserAddress] = useState<string>('')
  const [syncStatus, setSyncStatus] = useState<string>('未同步')

  const { trades, loading } = useTrades(undefined, userAddress)
  const { orders: myOrders, loading: ordersLoading, refresh: refreshMyOrders } = useMyOrders(userAddress)
  useSettleOnMatch(signer, userAddress)

  // 初始化 ethers.js Provider 和链上同步
  useEffect(() => {
    const initChainSync = async () => {
      try {
        // 1. 连接到区块链
        const ethProvider = new ethers.JsonRpcProvider(RPC_URL)
        setProvider(ethProvider)
        
        let userAddr: string | undefined
        if (window.ethereum) {
          const accounts = await window.ethereum.request({
            method: 'eth_requestAccounts',
          })
          userAddr = accounts[0]
          setUserAddress(userAddr ?? '')
          if (userAddr) {
            const wallet = new ethers.BrowserProvider(window.ethereum)
            const s = await wallet.getSigner()
            setSigner(s)
          }
          console.log('👤 用户地址:', userAddr)
        }
        await chainSyncService.init(ethProvider, SETTLEMENT_ADDRESS)
        await chainSyncService.startListening()
        setSyncStatus('同步中...')
        const syncedTrades = await chainSyncService.incrementalSync(userAddr ?? undefined)
        setSyncStatus(`已同步 ${syncedTrades.length} 条成交`)
        
        console.log('✅ 链上同步已启动')
      } catch (error) {
        console.error('❌ 初始化链上同步失败:', error)
        setSyncStatus('同步失败')
      }
    }

    if (storageEnabled) {
      initChainSync()
    }

    return () => {
      chainSyncService.stopListening()
    }
  }, [storageEnabled])

  // 定期增量同步（每 30 秒）
  useEffect(() => {
    if (!storageEnabled || !userAddress) return

    const interval = setInterval(async () => {
      try {
        const syncedTrades = await chainSyncService.incrementalSync(userAddress)
        if (syncedTrades.length > 0) {
          console.log(`🔄 增量同步: ${syncedTrades.length} 条新成交`)
        }
      } catch (error) {
        console.error('❌ 增量同步失败:', error)
      }
    }, 30000) // 30 秒

    return () => clearInterval(interval)
  }, [storageEnabled, userAddress])

  // 数据库统计
  const [dbStats, setDbStats] = useState({ orders: 0, matches: 0, trades: 0 })
  
  useEffect(() => {
    if (!storageEnabled) return

    const updateStats = async () => {
      const stats = await DatabaseManager.getStats()
      setDbStats(stats)
    }

    updateStats()
    const interval = setInterval(updateStats, 10000) // 每 10 秒更新

    return () => clearInterval(interval)
  }, [storageEnabled])

  // 导出数据（备份）
  const handleExport = async () => {
    try {
      const data = await DatabaseManager.exportData()
      const blob = new Blob([JSON.stringify(data, null, 2)], { 
        type: 'application/json' 
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `p2p-dex-backup-${Date.now()}.json`
      a.click()
      URL.revokeObjectURL(url)
      console.log('✅ 数据已导出')
    } catch (error) {
      console.error('❌ 导出失败:', error)
    }
  }

  // 导入数据（恢复）
  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    try {
      const file = event.target.files?.[0]
      if (!file) return

      const text = await file.text()
      const data = JSON.parse(text)
      
      await DatabaseManager.importData(data)
      console.log('✅ 数据已导入')
      
      // 刷新页面以重新加载数据
      window.location.reload()
    } catch (error) {
      console.error('❌ 导入失败:', error)
    }
  }

  // 清理旧数据
  const handleCleanup = async () => {
    if (!confirm('确定要清理 30 天前的旧数据吗？')) return
    
    try {
      await DatabaseManager.cleanup(30)
      console.log('✅ 清理完成')
      
      // 更新统计
      const stats = await DatabaseManager.getStats()
      setDbStats(stats)
    } catch (error) {
      console.error('❌ 清理失败:', error)
    }
  }

  return (
    <div style={{ padding: '20px', fontFamily: 'monospace' }}>
      <h1>P2P DEX - 分层存储示例</h1>
      
      {/* P2P 状态 */}
      <div style={{ marginBottom: '20px', padding: '10px', border: '1px solid #ccc' }}>
        <h2>P2P 节点状态</h2>
        <p>连接状态: {isConnected ? '✅ 已连接' : '❌ 未连接'}</p>
        <p>节点 ID: {peerId?.slice(0, 16)}...</p>
        <p>连接的 Peers: {peerCount}</p>
        <p>持久化存储: {storageEnabled ? '✅ 已启用' : '❌ 未启用'}</p>
      </div>

      {/* 链上同步状态 */}
      {storageEnabled && (
        <div style={{ marginBottom: '20px', padding: '10px', border: '1px solid #ccc' }}>
          <h2>链上同步状态</h2>
          <p>用户地址: {userAddress || '未连接钱包'}</p>
          <p>同步状态: {syncStatus}</p>
          <p>Settlement 合约: {SETTLEMENT_ADDRESS.slice(0, 10)}...</p>
        </div>
      )}

      {/* 数据库统计 */}
      {storageEnabled && (
        <div style={{ marginBottom: '20px', padding: '10px', border: '1px solid #ccc' }}>
          <h2>IndexedDB 统计</h2>
          <p>订单数: {dbStats.orders}</p>
          <p>撮合记录: {dbStats.matches}</p>
          <p>链上成交: {dbStats.trades}</p>
          
          <div style={{ marginTop: '10px' }}>
            <button onClick={handleExport} style={{ marginRight: '10px' }}>
              📥 导出数据
            </button>
            <label style={{ marginRight: '10px' }}>
              📤 导入数据
              <input 
                type="file" 
                accept=".json" 
                onChange={handleImport}
                style={{ display: 'none' }}
              />
            </label>
            <button onClick={handleCleanup}>
              🧹 清理旧数据
            </button>
          </div>
        </div>
      )}

      {/* 我的订单（IndexedDB：发单/匹配/结算时自动更新；启动加载 pending 到 UI） */}
      {storageEnabled && userAddress && (
        <div style={{ marginBottom: '20px', padding: '10px', border: '1px solid #ccc' }}>
          <h2>我的订单 {ordersLoading && '(加载中...)'}</h2>
          {myOrders.length === 0 ? (
            <p>暂无订单（下单后将持久化，关浏览器重开可恢复）</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ border: '1px solid #ccc', padding: '5px' }}>交易对</th>
                  <th style={{ border: '1px solid #ccc', padding: '5px' }}>方向</th>
                  <th style={{ border: '1px solid #ccc', padding: '5px' }}>价格</th>
                  <th style={{ border: '1px solid #ccc', padding: '5px' }}>数量</th>
                  <th style={{ border: '1px solid #ccc', padding: '5px' }}>状态</th>
                </tr>
              </thead>
              <tbody>
                {myOrders.slice(0, 20).map((o) => (
                  <tr key={o.orderId}>
                    <td style={{ border: '1px solid #ccc', padding: '5px' }}>{o.pair}</td>
                    <td style={{ border: '1px solid #ccc', padding: '5px' }}>{o.side === 'buy' ? '买' : '卖'}</td>
                    <td style={{ border: '1px solid #ccc', padding: '5px' }}>{o.price}</td>
                    <td style={{ border: '1px solid #ccc', padding: '5px' }}>{o.amount}</td>
                    <td style={{ border: '1px solid #ccc', padding: '5px' }}>{o.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 成交历史 */}
      <div style={{ marginBottom: '20px', padding: '10px', border: '1px solid #ccc' }}>
        <h2>成交历史 {loading && '(加载中...)'}</h2>
        {trades.length === 0 ? (
          <p>暂无成交记录</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ border: '1px solid #ccc', padding: '5px' }}>时间</th>
                <th style={{ border: '1px solid #ccc', padding: '5px' }}>交易对</th>
                <th style={{ border: '1px solid #ccc', padding: '5px' }}>价格</th>
                <th style={{ border: '1px solid #ccc', padding: '5px' }}>数量</th>
                <th style={{ border: '1px solid #ccc', padding: '5px' }}>Tx Hash</th>
              </tr>
            </thead>
            <tbody>
              {trades.slice(0, 10).map(trade => (
                <tr key={trade.tradeId}>
                  <td style={{ border: '1px solid #ccc', padding: '5px' }}>
                    {new Date(trade.timestamp).toLocaleString()}
                  </td>
                  <td style={{ border: '1px solid #ccc', padding: '5px' }}>
                    {trade.pair}
                  </td>
                  <td style={{ border: '1px solid #ccc', padding: '5px' }}>
                    {parseFloat(trade.price).toFixed(6)}
                  </td>
                  <td style={{ border: '1px solid #ccc', padding: '5px' }}>
                    {trade.amount}
                  </td>
                  <td style={{ border: '1px solid #ccc', padding: '5px' }}>
                    {trade.txHash ? (
                      <a 
                        href={`https://sepolia.etherscan.io/tx/${trade.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {trade.txHash.slice(0, 10)}...
                      </a>
                    ) : (
                      '待确认'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 分层存储说明 */}
      <div style={{ padding: '10px', border: '1px solid #ccc', backgroundColor: '#f9f9f9' }}>
        <h3>分层存储架构</h3>
        <ul>
          <li><strong>层级 1 (localStorage)</strong>: 用户配置、最近访问、同步位置</li>
          <li><strong>层级 2 (IndexedDB)</strong>: 完整订单簿、撮合记录、历史成交</li>
          <li><strong>层级 3 (链上)</strong>: 最终结算数据、永久存储</li>
        </ul>
        <p>
          数据流: P2P 订单广播 → IndexedDB 缓存 → 链上结算 → 事件同步回 IndexedDB
        </p>
      </div>
    </div>
  )
}

// 主 App 组件
export default function App() {
  return (
    <P2PProvider enableStorage={true}>
      <AppContent />
    </P2PProvider>
  )
}
