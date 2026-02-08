# 快速开始：分层存储

## 5 分钟集成指南

### 步骤 1: 安装依赖 ✅

```bash
cd frontend
npm install dexie
```

### 步骤 2: 启用持久化存储

在你的 `App.tsx` 中：

```tsx
import { P2PProvider } from './contexts/P2PContext'

function App() {
  return (
    {/* 设置 enableStorage={true} 启用 IndexedDB */}
    <P2PProvider enableStorage={true}>
      <YourComponents />
    </P2PProvider>
  )
}
```

### 步骤 3: 使用成交历史

```tsx
import { useTrades } from './hooks/useTrades'

function TradeHistory() {
  // 自动从 IndexedDB 加载历史 + 实时更新
  const { trades, loading } = useTrades()
  
  if (loading) return <div>加载中...</div>
  
  return (
    <div>
      <h2>成交历史</h2>
      {trades.map(trade => (
        <div key={trade.tradeId}>
          {trade.pair} - {trade.amount} @ {trade.price}
        </div>
      ))}
    </div>
  )
}
```

### 步骤 4: 添加链上同步（可选）

```tsx
import { useEffect } from 'react'
import { ethers } from 'ethers'
import { chainSyncService } from './services/chainSync'

function App() {
  useEffect(() => {
    const init = async () => {
      // 连接到区块链
      const provider = new ethers.JsonRpcProvider(
        'https://sepolia.infura.io/v3/YOUR_KEY'
      )
      
      // 初始化链上同步
      await chainSyncService.init(
        provider,
        '0xYourSettlementAddress'
      )
      
      // 开始监听
      await chainSyncService.startListening()
      
      // 同步历史（可选）
      await chainSyncService.incrementalSync()
    }
    
    init()
  }, [])
  
  return <YourApp />
}
```

## 完成！🎉

现在你的应用已经具备：

- ✅ **持久化存储**: 订单和成交保存在 IndexedDB
- ✅ **自动恢复**: 浏览器/客户端重启后数据不丢失
- ✅ **链上同步**: 自动同步链上成交到本地
- ✅ **自动清理**: 旧数据自动清理（订单 30 天，成交 90 天）

## 数据流

```
用户发布订单 → P2P 广播 → IndexedDB 保存
                    ↓
              撮合成功 → 链上结算
                    ↓
              监听事件 → IndexedDB 更新
                    ↓
              UI 自动刷新
```

## 高级功能

### 导出/导入数据

```tsx
import { DatabaseManager } from './p2p/storage'

// 导出
const data = await DatabaseManager.exportData()
// 保存为 JSON 文件...

// 导入
await DatabaseManager.importData(data)
```

### 查询订单

```tsx
import { OrderStorage } from './p2p/storage'

// 获取用户的待撮合订单
const orders = await OrderStorage.getUserOrders(
  userAddress,
  'pending'
)

// 获取交易对的活跃订单
const activeOrders = await OrderStorage.getActiveOrders('ETH/USDC')
```

### 查询成交

```tsx
import { TradeStorage } from './p2p/storage'

// 获取交易对的成交历史
const trades = await TradeStorage.getTradesByPair('ETH/USDC', 50)

// 获取用户的成交历史
const userTrades = await TradeStorage.getUserTrades(userAddress, 50)
```

## 故障排查

### 问题：数据没有保存

**检查**: 是否启用了存储？

```tsx
<P2PProvider enableStorage={true}> {/* 确保是 true */}
```

### 问题：链上同步失败

**检查**: RPC URL 和合约地址是否正确？

```tsx
const provider = new ethers.JsonRpcProvider(RPC_URL)
await chainSyncService.init(provider, SETTLEMENT_ADDRESS)
```

### 问题：浏览器控制台报错

**检查**: 是否安装了 dexie？

```bash
npm install dexie
```

## 更多信息

查看完整文档：`frontend/STORAGE-INTEGRATION.md`

查看完整示例：`frontend/src/App.integration.example.tsx`
