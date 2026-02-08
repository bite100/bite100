# P2P DEX SDK

P2P DEX 官方 SDK 和示例代码，便于第三方开发者集成。

## 目录结构

```
sdk/
├── js/          # JavaScript/TypeScript SDK
├── go/          # Go SDK 示例
└── README.md    # 本文件

examples/
└── third-party-integration/  # 第三方接入完整示例
    ├── javascript/          # JS 示例
    ├── go/                   # Go 示例
    └── python/               # Python 示例
```

## JavaScript/TypeScript SDK

见 [js/README.md](./js/README.md)

**特性**：
- 完整的类型定义
- EIP-712 签名支持
- 自动重试和错误处理
- 支持多节点配置

**安装**：
```bash
npm install @p2p-dex/sdk
```

## Go SDK

见 [go/README.md](./go/README.md)

**特性**：
- 简洁的 API 客户端
- 完整的错误处理
- 支持并发请求

## 示例代码

见 [examples/third-party-integration/](../examples/third-party-integration/)

包含：
- 交易机器人示例
- 订单监控示例
- 多语言 API 客户端示例

## 快速开始

### JavaScript

```typescript
import { NodeAPIClient } from '@p2p-dex/sdk'

const client = new NodeAPIClient({ baseUrl: 'http://localhost:8080' })
const orderbook = await client.getOrderbook('TKA/TKB')
```

### Go

```go
import "net/http"

resp, err := http.Get("http://localhost:8080/api/orderbook?pair=TKA/TKB")
// 处理响应...
```

## 文档

- [公开 API 文档](../../docs/公开API文档.md) - 完整的 API 说明
- [API 接口说明](../../docs/API-接口说明.md) - 智能合约接口

## 许可证

MIT
