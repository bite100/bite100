# P2P DEX 公开 API 文档

> 版本：v1.0  
> 更新日期：2025-02-08  
> 本文档面向第三方开发者，提供接入 P2P DEX 节点与合约的 API 说明

---

## 一、概述

P2P DEX 提供两类 API：
1. **节点 HTTP API**：链下订单簿、下单/撤单、成交查询（Phase 3.5）
2. **智能合约接口**：链上资产托管、结算、治理等

### 1.1 节点 API 端点

节点 API 地址由节点配置的 `api.listen` 决定（如 `:8080`）。支持多节点配置，前端可按 P2P 方式依次尝试连接。

**基础 URL**：`http://<节点IP>:<端口>`

### 1.2 智能合约

所有合约已部署在 Sepolia 测试网（Chain ID: 11155111）。合约地址见 [API-接口说明.md](./API-接口说明.md#12-合约地址sepolia)。

---

## 二、节点 HTTP API

### 2.1 订单簿查询

**端点**：`GET /api/orderbook`

**查询参数**：
- `pair`（必需）：交易对，如 `TKA/TKB`

**响应示例**：
```json
{
  "pair": "TKA/TKB",
  "bids": [
    {
      "orderId": "0x123...",
      "trader": "0xabc...",
      "pair": "TKA/TKB",
      "side": "buy",
      "price": "1.5",
      "amount": "100",
      "filled": "0",
      "status": "open",
      "nonce": 1,
      "createdAt": 1707123456,
      "expiresAt": 1707728256
    }
  ],
  "asks": [
    {
      "orderId": "0x456...",
      "trader": "0xdef...",
      "pair": "TKA/TKB",
      "side": "sell",
      "price": "1.6",
      "amount": "50",
      "filled": "0",
      "status": "open",
      "nonce": 2,
      "createdAt": 1707123457,
      "expiresAt": 1707728257
    }
  ]
}
```

### 2.2 成交查询

**端点**：`GET /api/trades`

**查询参数**：
- `pair`（可选）：交易对过滤
- `limit`（可选）：返回数量限制（默认 50，最大 200）
- `since`（可选）：起始时间戳（Unix 秒）
- `until`（可选）：结束时间戳（Unix 秒）

**响应示例**：
```json
[
  {
    "tradeId": "trade-123",
    "pair": "TKA/TKB",
    "makerOrderID": "0x123...",
    "takerOrderID": "0x456...",
    "maker": "0xabc...",
    "taker": "0xdef...",
    "tokenIn": "0x678195277dc8F84F787A4694DF42F3489eA757bf",
    "tokenOut": "0x9Be241a0bF1C2827194333B57278d1676494333a",
    "amountIn": "100",
    "amountOut": "150",
    "price": "1.5",
    "amount": "100",
    "timestamp": 1707123456,
    "txHash": "0x789..."
  }
]
```

### 2.3 查询我的订单

**端点**：`GET /api/orders`

**查询参数**：
- `trader`（可选）：交易者地址
- `pair`（可选）：交易对过滤
- `limit`（可选）：返回数量限制（默认 50，最大 200）

### 2.4 下单

**端点**：`POST /api/order`

**请求体**：
```json
{
  "orderId": "0x123...",
  "trader": "0xabc...",
  "pair": "TKA/TKB",
  "side": "buy",
  "price": "1.5",
  "amount": "100",
  "nonce": 1,
  "createdAt": 1707123456,
  "expiresAt": 1707728256,
  "signature": "0x..."
}
```

**说明**：
- `orderId`：订单唯一标识（建议使用 `keccak256(trader + nonce + pair + price + amount + timestamp)`）
- `signature`：EIP-712 格式签名（可选，但推荐使用以验证订单真实性）
- `side`：`buy` 或 `sell`
- `expiresAt`：订单过期时间戳（Unix 秒）

**响应**：
```json
{
  "ok": true,
  "orderId": "0x123..."
}
```

### 2.5 撤单

**端点**：`POST /api/order/cancel`

**请求体**：
```json
{
  "orderId": "0x123...",
  "signature": "0x...",
  "timestamp": 1707123456
}
```

**说明**：
- `signature`：EIP-712 格式签名（可选，但推荐使用）
- `timestamp`：签名时间戳（Unix 秒）

**响应**：
```json
{
  "ok": true
}
```

### 2.6 节点信息

**端点**：`GET /api/node`

**响应示例**：
```json
{
  "type": "match",
  "peerId": "12D3KooW..."
}
```

### 2.7 WebSocket 实时推送

**端点**：`WS /ws`

**消息格式**：
- 订单状态更新：`{"type":"order","data":{...}}`
- 成交通知：`{"type":"trade","data":{...}}`

---

## 三、EIP-712 签名格式

### 3.1 订单签名

**Domain**：
```json
{
  "name": "P2P DEX",
  "version": "1",
  "chainId": 11155111
}
```

**Order 类型**：
```json
{
  "Order": [
    {"name": "orderId", "type": "string"},
    {"name": "userAddress", "type": "address"},
    {"name": "tokenIn", "type": "address"},
    {"name": "tokenOut", "type": "address"},
    {"name": "amountIn", "type": "uint256"},
    {"name": "amountOut", "type": "uint256"},
    {"name": "price", "type": "uint256"},
    {"name": "timestamp", "type": "uint256"},
    {"name": "expiresAt", "type": "uint256"}
  ]
}
```

**Message 示例**：
```json
{
  "orderId": "0x123...",
  "userAddress": "0xabc...",
  "tokenIn": "0x678195277dc8F84F787A4694DF42F3489eA757bf",
  "tokenOut": "0x9Be241a0bF1C2827194333B57278d1676494333a",
  "amountIn": "1000000000000000000",
  "amountOut": "1500000000000000000",
  "price": "1500000000000000000",
  "timestamp": "1707123456",
  "expiresAt": "1707728256"
}
```

**说明**：
- `tokenIn`/`tokenOut`：根据 `side` 确定（buy: tokenIn=Token0, tokenOut=Token1；sell: tokenIn=Token0, tokenOut=Token1）
- `amountOut` = `amountIn * price`（以最小单位计算）
- 所有数值使用字符串表示（避免精度问题）

### 3.2 取消订单签名

**CancelOrder 类型**：
```json
{
  "CancelOrder": [
    {"name": "orderId", "type": "string"},
    {"name": "userAddress", "type": "address"},
    {"name": "timestamp", "type": "uint256"}
  ]
}
```

---

## 四、智能合约接口

详见 [API-接口说明.md](./API-接口说明.md)。

主要合约：
- **Vault**：资产托管（deposit/withdraw）
- **Settlement**：交易结算（settleTrade/settleTradesBatch）
- **AMMPool**：AMM Swap
- **FeeDistributor**：手续费分配
- **Governance**：治理投票
- **ContributorReward**：贡献奖励

---

## 五、SDK 与示例代码

### 5.1 前端 SDK

前端使用 `ethers.js` 与合约交互，使用 `fetch` 调用节点 API。

**示例：查询订单簿**
```javascript
const response = await fetch('http://localhost:8080/api/orderbook?pair=TKA/TKB');
const data = await response.json();
console.log('Bids:', data.bids);
console.log('Asks:', data.asks);
```

**示例：下单**
```javascript
import { ethers } from 'ethers';

// 构造订单
const order = {
  orderId: ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint256', 'string', 'string', 'string', 'uint256'],
    [trader, nonce, pair, price, amount, timestamp]
  )),
  trader: signer.address,
  pair: 'TKA/TKB',
  side: 'buy',
  price: ethers.parseEther('1.5').toString(),
  amount: ethers.parseEther('100').toString(),
  nonce: 1,
  createdAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
};

// EIP-712 签名（使用 ethers.js v6）
const domain = {
  name: 'P2P DEX',
  version: '1',
  chainId: 11155111,
};
const types = {
  Order: [
    { name: 'orderId', type: 'string' },
    { name: 'userAddress', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'amountOut', type: 'uint256' },
    { name: 'price', type: 'uint256' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
  ],
};
const signature = await signer.signTypedData(domain, types, order);

order.signature = signature;

// 提交订单
const response = await fetch('http://localhost:8080/api/order', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(order),
});
```

### 5.2 Go SDK（节点端）

节点端使用 `go-ethereum` 与合约交互。

**示例：查询订单簿**
```go
import (
    "encoding/json"
    "net/http"
)

type OrderbookResponse struct {
    Pair string    `json:"pair"`
    Bids []Order   `json:"bids"`
    Asks []Order   `json:"asks"`
}

resp, err := http.Get("http://localhost:8080/api/orderbook?pair=TKA/TKB")
if err != nil {
    return err
}
defer resp.Body.Close()

var data OrderbookResponse
if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
    return err
}
```

---

## 六、错误处理

### 6.1 HTTP 状态码

- `200`：成功
- `400`：请求参数错误
- `401`：签名验证失败
- `500`：服务器内部错误
- `503`：服务不可用（如节点未配置 API）

### 6.2 错误响应格式

```json
{
  "error": "invalid signature"
}
```

---

## 七、限流与注意事项

1. **节点限流**：中继节点可能对每个 peer 进行限流（配置 `relay.rate_limit_*`）
2. **订单过期**：订单超过 `expiresAt` 后自动失效
3. **签名验证**：推荐所有订单和撤单请求都包含签名
4. **多节点**：前端应配置多个节点 URL，按 P2P 方式依次尝试连接

---

## 八、合规说明

1. **第三方接入**：需遵守当地法律法规，不得用于非法用途
2. **数据使用**：节点数据仅供交易使用，不得用于其他商业目的
3. **风险提示**：链下订单簿数据可能延迟或不一致，最终以链上结算为准
4. **免责声明**：P2P DEX 为去中心化协议，开发者不对第三方接入造成的损失负责

---

## 九、更新日志

- **v1.0**（2025-02-08）：初始版本，包含节点 API 和 EIP-712 签名说明

---

## 十、联系方式

- **文档问题**：提交 Issue 到项目仓库
- **技术讨论**：参与项目社区讨论

---

*本文档随项目进展随时更新，请以最新版本为准。*
