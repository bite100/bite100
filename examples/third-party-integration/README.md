# 第三方接入完整示例

本目录包含第三方开发者接入 P2P DEX 的完整示例代码。

## 目录结构

```
examples/third-party-integration/
├── README.md              # 本文件
├── javascript/            # JavaScript/TypeScript 示例
│   ├── trading-bot.js    # 交易机器人示例
│   └── order-monitor.js  # 订单监控示例
├── go/                    # Go 示例
│   └── node-client.go    # Go 节点客户端示例
└── python/               # Python 示例
    └── api-client.py     # Python API 客户端示例
```

## JavaScript 示例

### 交易机器人

见 `javascript/trading-bot.js`，展示如何：
- 连接节点 API
- 监控订单簿变化
- 自动下单和撤单
- 处理错误和重连

### 订单监控

见 `javascript/order-monitor.js`，展示如何：
- 实时监控订单状态
- WebSocket 连接
- 订单状态变化通知

## Go 示例

见 `go/node-client.go`，展示如何：
- 创建 Go 客户端
- 查询订单簿和成交
- 批量处理订单

## Python 示例

见 `python/api-client.py`，展示如何：
- 使用 Python 调用节点 API
- 处理 JSON 响应
- 错误处理

## 使用说明

1. 确保节点已启动并配置了 `api.listen`
2. 根据你的语言选择对应的示例
3. 修改配置（节点地址、交易对等）
4. 运行示例代码

## 注意事项

- 所有示例仅用于演示，生产环境需要添加更多错误处理
- 订单签名需要使用 EIP-712 格式
- 建议使用 SDK 而不是直接调用 API（见 `sdk/` 目录）
