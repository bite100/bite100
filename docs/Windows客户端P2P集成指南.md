# Windows 客户端 P2P 集成指南

## 概述

Windows 客户端（Electron）已集成 JS-libp2p P2P 网络，使用 TCP transport（Node.js 环境），比浏览器 WebSocket 更稳定。

## 功能特性

### 1. P2P 模式

- **libp2p 模式（推荐）**：使用 JS-libp2p TCP transport，无需 Go 节点
- **WebSocket 桥接模式**：连接到 Go 节点的 WebSocket（兼容旧版）

### 2. 性能优化

- **最大连接数限制**：100 peers（可配置）
- **DHT 缓存**：使用 Kademlia DHT 缓存热门订单
- **自动连接管理**：自动断开低质量连接，保持最优连接数

### 3. 安全特性

- **订单签名验证**：所有订单使用 EIP-712 签名，验证 maker 地址
- **撤单签名验证**：防止未授权撤单

## 安装依赖

```bash
cd frontend
npm install
```

新增依赖：
- `@libp2p/tcp`: TCP transport（Node.js 环境）

## 构建配置

### package.json 脚本

```json
{
  "scripts": {
    "dev:electron": "concurrently \"npm run dev\" \"wait-on http://localhost:5173 && cross-env NODE_ENV=development electron .\"",
    "electron:dev": "npm run dev:electron",
    "electron:build": "npm run build:electron && electron-builder --win --publish=never",
    "dist": "npm run electron:build"
  }
}
```

### vite.config.ts 优化

- **树摇**：排除开发依赖，减小 bundle 大小
- **代码分割**：libp2p、ethers、react 单独打包
- **目标大小**：< 5MB

### electron-builder 配置

- **发布模式**：`--publish=never`（避免自动上传）
- **输出目录**：`frontend/release/`

## 运行

### 开发模式

```bash
npm run electron:dev
```

这会：
1. 启动 Vite 开发服务器（http://localhost:5173）
2. 等待服务器就绪后启动 Electron 窗口
3. 自动加载 MetaMask 扩展（如果已安装）

### 生产构建

```bash
npm run dist
```

输出：`frontend/release/P2P 交易所 Setup 0.0.1.exe`

## P2P 配置

### 环境变量

- `P2P_MODE`: `libp2p`（推荐）或 `ws`（WebSocket 桥接）
- `P2P_BOOTSTRAP`: Bootstrap 节点列表（逗号分隔）
- `P2P_WS_URL`: WebSocket 桥接地址（P2P_MODE=ws 时使用）

示例：

```bash
# libp2p 模式（默认）
cross-env P2P_MODE=libp2p electron .

# WebSocket 桥接模式
cross-env P2P_MODE=ws P2P_WS_URL=ws://localhost:9000 electron .

# 自定义 Bootstrap 节点
cross-env P2P_MODE=libp2p P2P_BOOTSTRAP=/ip4/1.2.3.4/tcp/9000/p2p/QmXxxx electron .
```

## 代码结构

### Electron Main 进程

- `electron/main.js`: Electron 主进程
  - 初始化 P2P 客户端（`startP2PClient`）
  - 或启动 WebSocket 桥接（`startP2PBridge`）

### P2P 客户端服务

- `src/services/p2p-client.ts`: Electron P2P 客户端（Node.js TCP）
  - `initP2PClient()`: 初始化 P2P 节点
  - `getP2PNode()`: 获取节点实例
  - `stopP2PClient()`: 停止节点

### 订单验证

- `src/services/orderVerification.ts`: 订单签名验证
  - `verifyOrderSignature()`: 验证订单签名
  - `verifyCancelOrderSignature()`: 验证撤单签名

### P2P 节点配置

- `src/p2p/node.ts`: 浏览器 P2P 节点（WebRTC + WebSocket）
- `src/p2p/orderSubscriber.ts`: 订单订阅器（已集成签名验证）

## 性能指标

### Bundle 大小优化

- **目标**：< 5MB
- **策略**：
  - 树摇排除 dev 依赖
  - libp2p 单独打包
  - 代码分割（ethers、react 单独 chunk）

### 连接管理

- **最大连接数**：100 peers
- **最小连接数**：5 peers
- **自动拨号间隔**：10 秒
- **DHT 查询超时**：10 秒

## 安全说明

### 订单签名

所有订单必须包含有效的 EIP-712 签名：

```typescript
import { signOrder } from './services/orderSigning'

const signature = await signOrder(orderData, signer)
order.signature = signature
```

### 签名验证

订单订阅器自动验证所有收到的订单：

```typescript
// orderSubscriber.ts 中自动验证
const isValid = await verifyOrderSignature(order)
if (!isValid) {
  // 拒绝订单
  return
}
```

## 故障排查

### P2P 客户端启动失败

如果 JS-libp2p 启动失败，会自动回退到 WebSocket 桥接模式。

检查日志：
```
✅ JS-libp2p P2P 客户端已启动
📍 PeerID: QmXxxx...
🔗 传输协议: TCP (Node.js)
```

### 连接问题

1. **检查防火墙**：确保 TCP 端口未被阻止
2. **检查 Bootstrap 节点**：确保节点地址正确
3. **查看连接日志**：`🔗 已连接节点: /ip4/...`

### Bundle 大小过大

1. 检查 `vite.config.ts` 中的 `optimizeDeps.exclude`
2. 运行 `npm run build:electron` 查看 bundle 分析
3. 移除未使用的依赖

## GitHub Actions

Windows 客户端构建在 `.github/workflows/build-windows.yml` 中配置：

```yaml
- run: npm run electron:build
  working-directory: frontend
```

构建产物：
- `frontend/release/*.exe`
- 上传到 GitHub Actions Artifacts
- Release 时自动上传到 GitHub Releases

## 相关文档

- [客户端P2P运行指南](./客户端P2P运行指南.md)
- [P2P节点整合交易撮合指南](./P2P节点整合交易撮合指南.md)
- [订单签名与验证](./订单签名与验证.md)
