# P2P 节点整合交易撮合：步步指南

## 概述

将 P2P 节点深度整合到交易撮合中，实现**混合模式**：
- **Off-chain P2P**：订单发现、初步匹配（广播订单、peer-to-peer 协商）
- **On-chain**：最终结算（调用 Settlement 合约，避免中心化撮合）

这能实现真正的"P2P DEX"：用户间直接匹配，减少链上负载。

---

## 1. 准备环境 & 运行基础节点

### 1.1 Clone 仓库并安装依赖

```bash
# Clone 仓库
git clone https://github.com/P2P-P2P/p2p.git
cd p2p/node

# 安装 Go 依赖
go mod tidy
```

### 1.2 运行单个节点

```bash
# 方式一：直接运行
go run ./cmd/node

# 方式二：使用脚本（Windows）
.\run.ps1

# 方式三：使用脚本（Linux/macOS）
chmod +x run.sh && ./run.sh
```

节点启动后会输出：
```
节点启动 | PeerID: 12D3KooW...
  监听: /ip4/127.0.0.1/tcp/4001/p2p/12D3KooW...
```

### 1.3 Docker 多节点模拟

```bash
# 在项目根目录
docker-compose up --scale node=3
```

这会创建 3 个节点互相发现，测试网络连通性。


---

## 2. 定义 P2P 协议：订单消息格式

### 2.1 使用 GossipSub 广播订单

libp2p 支持自定义协议。为交易添加专属协议：

**PubSub 主题**：
- `/p2p-exchange/order/new` - 新订单广播
- `/p2p-exchange/order/cancel` - 取消订单
- `/p2p-exchange/trade/executed` - 成交通知
- `/p2p-exchange/sync/orderbook` - 订单簿同步

### 2.2 订单消息结构

创建 `node/proto/order.proto`：

```protobuf
syntax = "proto3";
package p2pexchange;

// 订单消息
message Order {
  string order_id = 1;        // 订单唯一 ID
  string user_address = 2;    // 用户钱包地址
  string token_in = 3;        // 卖出代币地址
  string token_out = 4;       // 买入代币地址
  string amount_in = 5;       // 卖出数量（字符串，避免精度问题）
  string amount_out = 6;      // 期望买入数量
  string price = 7;           // 价格
  int64 timestamp = 8;        // 时间戳
  string signature = 9;       // 用户签名（防伪造）
  OrderType type = 10;        // 订单类型
  
  enum OrderType {
    LIMIT = 0;   // 限价单
    MARKET = 1;  // 市价单
  }
}

// 取消订单消息
message CancelOrder {
  string order_id = 1;
  string user_address = 2;
  int64 timestamp = 3;
  string signature = 4;
}

// 成交消息
message Trade {
  string trade_id = 1;
  string maker_order_id = 2;
  string taker_order_id = 3;
  string maker_address = 4;
  string taker_address = 5;
  string token_in = 6;
  string token_out = 7;
  string amount_in = 8;
  string amount_out = 9;
  int64 timestamp = 10;
  string tx_hash = 11;  // 链上结算交易哈希
}
```

### 2.3 生成 Go 代码

```bash
# 安装 protoc 编译器
# Windows: 下载 https://github.com/protocolbuffers/protobuf/releases
# Linux: sudo apt install protobuf-compiler
# macOS: brew install protobuf

# 安装 Go 插件
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest

# 生成代码
cd node
protoc --go_out=. --go_opt=paths=source_relative proto/order.proto
```


---

## 3. 实现订单广播与订阅

### 3.1 修改节点配置

编辑 `node/config.yaml`，添加订单相关主题：

```yaml
network:
  topics:
    - /p2p-exchange/order/new
    - /p2p-exchange/order/cancel
    - /p2p-exchange/trade/executed
    - /p2p-exchange/sync/orderbook
```

### 3.2 订单广播实现

在 `node/internal/sync/order_publisher.go` 中实现：

```go
package sync

import (
    "context"
    "encoding/json"
    "github.com/libp2p/go-libp2p/core/host"
    pubsub "github.com/libp2p/go-libp2p-pubsub"
)

type OrderPublisher struct {
    host   host.Host
    pubsub *pubsub.PubSub
    topics map[string]*pubsub.Topic
}

func NewOrderPublisher(h host.Host, ps *pubsub.PubSub) (*OrderPublisher, error) {
    op := &OrderPublisher{
        host:   h,
        pubsub: ps,
        topics: make(map[string]*pubsub.Topic),
    }
    
    // 订阅主题
    topicNames := []string{
        "/p2p-exchange/order/new",
        "/p2p-exchange/order/cancel",
        "/p2p-exchange/trade/executed",
    }
    
    for _, name := range topicNames {
        topic, err := ps.Join(name)
        if err != nil {
            return nil, err
        }
        op.topics[name] = topic
    }
    
    return op, nil
}

// 广播新订单
func (op *OrderPublisher) PublishOrder(ctx context.Context, order *Order) error {
    data, err := json.Marshal(order)
    if err != nil {
        return err
    }
    
    topic := op.topics["/p2p-exchange/order/new"]
    return topic.Publish(ctx, data)
}

// 广播取消订单
func (op *OrderPublisher) PublishCancel(ctx context.Context, cancel *CancelOrder) error {
    data, err := json.Marshal(cancel)
    if err != nil {
        return err
    }
    
    topic := op.topics["/p2p-exchange/order/cancel"]
    return topic.Publish(ctx, data)
}

// 广播成交
func (op *OrderPublisher) PublishTrade(ctx context.Context, trade *Trade) error {
    data, err := json.Marshal(trade)
    if err != nil {
        return err
    }
    
    topic := op.topics["/p2p-exchange/trade/executed"]
    return topic.Publish(ctx, data)
}
```


### 3.3 订单订阅与处理

在 `node/internal/sync/order_subscriber.go` 中实现：

```go
package sync

import (
    "context"
    "encoding/json"
    "log"
    pubsub "github.com/libp2p/go-libp2p-pubsub"
)

type OrderHandler interface {
    OnNewOrder(order *Order) error
    OnCancelOrder(cancel *CancelOrder) error
    OnTradeExecuted(trade *Trade) error
}

type OrderSubscriber struct {
    pubsub  *pubsub.PubSub
    handler OrderHandler
}

func NewOrderSubscriber(ps *pubsub.PubSub, handler OrderHandler) *OrderSubscriber {
    return &OrderSubscriber{
        pubsub:  ps,
        handler: handler,
    }
}

func (os *OrderSubscriber) Start(ctx context.Context) error {
    // 订阅新订单
    if err := os.subscribeNewOrders(ctx); err != nil {
        return err
    }
    
    // 订阅取消订单
    if err := os.subscribeCancelOrders(ctx); err != nil {
        return err
    }
    
    // 订阅成交通知
    if err := os.subscribeTradeExecuted(ctx); err != nil {
        return err
    }
    
    return nil
}

func (os *OrderSubscriber) subscribeNewOrders(ctx context.Context) error {
    topic, err := os.pubsub.Join("/p2p-exchange/order/new")
    if err != nil {
        return err
    }
    
    sub, err := topic.Subscribe()
    if err != nil {
        return err
    }
    
    go func() {
        for {
            msg, err := sub.Next(ctx)
            if err != nil {
                log.Printf("订阅新订单错误: %v", err)
                return
            }
            
            var order Order
            if err := json.Unmarshal(msg.Data, &order); err != nil {
                log.Printf("解析订单失败: %v", err)
                continue
            }
            
            if err := os.handler.OnNewOrder(&order); err != nil {
                log.Printf("处理新订单失败: %v", err)
            }
        }
    }()
    
    return nil
}

func (os *OrderSubscriber) subscribeCancelOrders(ctx context.Context) error {
    topic, err := os.pubsub.Join("/p2p-exchange/order/cancel")
    if err != nil {
        return err
    }
    
    sub, err := topic.Subscribe()
    if err != nil {
        return err
    }
    
    go func() {
        for {
            msg, err := sub.Next(ctx)
            if err != nil {
                return
            }
            
            var cancel CancelOrder
            if err := json.Unmarshal(msg.Data, &cancel); err != nil {
                continue
            }
            
            os.handler.OnCancelOrder(&cancel)
        }
    }()
    
    return nil
}

func (os *OrderSubscriber) subscribeTradeExecuted(ctx context.Context) error {
    topic, err := os.pubsub.Join("/p2p-exchange/trade/executed")
    if err != nil {
        return err
    }
    
    sub, err := topic.Subscribe()
    if err != nil {
        return err
    }
    
    go func() {
        for {
            msg, err := sub.Next(ctx)
            if err != nil {
                return
            }
            
            var trade Trade
            if err := json.Unmarshal(msg.Data, &trade); err != nil {
                continue
            }
            
            os.handler.OnTradeExecuted(&trade)
        }
    }()
    
    return nil
}
```


---

## 4. 实现撮合引擎

### 4.1 订单簿数据结构

在 `node/internal/match/orderbook.go` 中实现：

```go
package match

import (
    "container/heap"
    "sync"
)

// 订单簿
type OrderBook struct {
    mu       sync.RWMutex
    pair     string
    bids     *PriceLevel  // 买单（价格从高到低）
    asks     *PriceLevel  // 卖单（价格从低到高）
    orders   map[string]*Order  // 订单 ID -> 订单
}

// 价格级别（使用堆实现）
type PriceLevel struct {
    orders []*Order
}

func (pl *PriceLevel) Len() int { return len(pl.orders) }
func (pl *PriceLevel) Less(i, j int) bool {
    // 买单：价格高优先，价格相同时间早优先
    // 卖单：价格低优先，价格相同时间早优先
    if pl.orders[i].Price == pl.orders[j].Price {
        return pl.orders[i].Timestamp < pl.orders[j].Timestamp
    }
    return pl.orders[i].Price > pl.orders[j].Price
}
func (pl *PriceLevel) Swap(i, j int) {
    pl.orders[i], pl.orders[j] = pl.orders[j], pl.orders[i]
}
func (pl *PriceLevel) Push(x interface{}) {
    pl.orders = append(pl.orders, x.(*Order))
}
func (pl *PriceLevel) Pop() interface{} {
    old := pl.orders
    n := len(old)
    x := old[n-1]
    pl.orders = old[0 : n-1]
    return x
}

func NewOrderBook(pair string) *OrderBook {
    return &OrderBook{
        pair:   pair,
        bids:   &PriceLevel{orders: make([]*Order, 0)},
        asks:   &PriceLevel{orders: make([]*Order, 0)},
        orders: make(map[string]*Order),
    }
}

// 添加订单
func (ob *OrderBook) AddOrder(order *Order) {
    ob.mu.Lock()
    defer ob.mu.Unlock()
    
    ob.orders[order.OrderID] = order
    
    if order.Side == "buy" {
        heap.Push(ob.bids, order)
    } else {
        heap.Push(ob.asks, order)
    }
}

// 取消订单
func (ob *OrderBook) CancelOrder(orderID string) bool {
    ob.mu.Lock()
    defer ob.mu.Unlock()
    
    order, exists := ob.orders[orderID]
    if !exists {
        return false
    }
    
    delete(ob.orders, orderID)
    
    // 从堆中移除（标记为已取消，实际移除在匹配时）
    order.Status = "cancelled"
    return true
}

// 获取最佳买价
func (ob *OrderBook) BestBid() *Order {
    ob.mu.RLock()
    defer ob.mu.RUnlock()
    
    if ob.bids.Len() == 0 {
        return nil
    }
    return ob.bids.orders[0]
}

// 获取最佳卖价
func (ob *OrderBook) BestAsk() *Order {
    ob.mu.RLock()
    defer ob.mu.RUnlock()
    
    if ob.asks.Len() == 0 {
        return nil
    }
    return ob.asks.orders[0]
}
```


### 4.2 撮合引擎实现

在 `node/internal/match/engine.go` 中实现：

```go
package match

import (
    "context"
    "log"
    "math/big"
)

type MatchEngine struct {
    orderbooks map[string]*OrderBook  // 交易对 -> 订单簿
    publisher  OrderPublisher
    settler    SettlementClient
}

func NewMatchEngine(publisher OrderPublisher, settler SettlementClient) *MatchEngine {
    return &MatchEngine{
        orderbooks: make(map[string]*OrderBook),
        publisher:  publisher,
        settler:    settler,
    }
}

// 实现 OrderHandler 接口
func (me *MatchEngine) OnNewOrder(order *Order) error {
    log.Printf("收到新订单: %s, 交易对: %s, 价格: %s", order.OrderID, order.Pair, order.Price)
    
    // 验证订单签名
    if !me.verifyOrderSignature(order) {
        log.Printf("订单签名验证失败: %s", order.OrderID)
        return nil
    }
    
    // 获取或创建订单簿
    ob, exists := me.orderbooks[order.Pair]
    if !exists {
        ob = NewOrderBook(order.Pair)
        me.orderbooks[order.Pair] = ob
    }
    
    // 尝试撮合
    trades := me.matchOrder(ob, order)
    
    // 如果有成交，广播并链上结算
    for _, trade := range trades {
        // 广播成交
        if err := me.publisher.PublishTrade(context.Background(), trade); err != nil {
            log.Printf("广播成交失败: %v", err)
        }
        
        // 链上结算
        if err := me.settler.SettleTrade(trade); err != nil {
            log.Printf("链上结算失败: %v", err)
        }
    }
    
    // 如果订单未完全成交，加入订单簿
    if order.RemainingAmount.Cmp(big.NewInt(0)) > 0 {
        ob.AddOrder(order)
    }
    
    return nil
}

func (me *MatchEngine) OnCancelOrder(cancel *CancelOrder) error {
    log.Printf("收到取消订单: %s", cancel.OrderID)
    
    // 验证签名
    if !me.verifyCancelSignature(cancel) {
        return nil
    }
    
    // 从所有订单簿中查找并取消
    for _, ob := range me.orderbooks {
        if ob.CancelOrder(cancel.OrderID) {
            log.Printf("订单已取消: %s", cancel.OrderID)
            break
        }
    }
    
    return nil
}

func (me *MatchEngine) OnTradeExecuted(trade *Trade) error {
    log.Printf("收到成交通知: %s", trade.TradeID)
    // 存储节点可以在这里持久化成交记录
    return nil
}

// Price-Time 撮合算法
func (me *MatchEngine) matchOrder(ob *OrderBook, order *Order) []*Trade {
    trades := make([]*Trade, 0)
    
    if order.Side == "buy" {
        // 买单与卖单撮合
        for ob.BestAsk() != nil && order.RemainingAmount.Cmp(big.NewInt(0)) > 0 {
            ask := ob.BestAsk()
            
            // 价格不匹配，停止撮合
            if order.Price.Cmp(ask.Price) < 0 {
                break
            }
            
            // 计算成交量
            matchAmount := min(order.RemainingAmount, ask.RemainingAmount)
            
            // 创建成交记录
            trade := &Trade{
                TradeID:       generateTradeID(),
                MakerOrderID:  ask.OrderID,
                TakerOrderID:  order.OrderID,
                MakerAddress:  ask.UserAddress,
                TakerAddress:  order.UserAddress,
                TokenIn:       order.TokenIn,
                TokenOut:      order.TokenOut,
                AmountIn:      matchAmount.String(),
                AmountOut:     new(big.Int).Mul(matchAmount, ask.Price).String(),
                Timestamp:     time.Now().Unix(),
            }
            
            trades = append(trades, trade)
            
            // 更新剩余量
            order.RemainingAmount.Sub(order.RemainingAmount, matchAmount)
            ask.RemainingAmount.Sub(ask.RemainingAmount, matchAmount)
            
            // 如果卖单完全成交，从订单簿移除
            if ask.RemainingAmount.Cmp(big.NewInt(0)) == 0 {
                heap.Pop(ob.asks)
            }
        }
    } else {
        // 卖单与买单撮合（类似逻辑）
        // ...
    }
    
    return trades
}

func (me *MatchEngine) verifyOrderSignature(order *Order) bool {
    // TODO: 实现 ECDSA 签名验证
    // 1. 构造消息哈希（订单字段）
    // 2. 使用 signature 恢复公钥
    // 3. 验证公钥对应的地址是否与 user_address 一致
    return true
}

func (me *MatchEngine) verifyCancelSignature(cancel *CancelOrder) bool {
    // TODO: 实现取消订单签名验证
    return true
}
```


---

## 5. 链上结算集成

### 5.1 Settlement 客户端

在 `node/internal/settlement/client.go` 中实现：

```go
package settlement

import (
    "context"
    "crypto/ecdsa"
    "math/big"
    
    "github.com/ethereum/go-ethereum/accounts/abi/bind"
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/ethclient"
)

type SettlementClient struct {
    client   *ethclient.Client
    contract *Settlement  // 生成的合约绑定
    auth     *bind.TransactOpts
}

func NewSettlementClient(rpcURL string, contractAddr common.Address, privateKey *ecdsa.PrivateKey) (*SettlementClient, error) {
    client, err := ethclient.Dial(rpcURL)
    if err != nil {
        return nil, err
    }
    
    contract, err := NewSettlement(contractAddr, client)
    if err != nil {
        return nil, err
    }
    
    chainID, err := client.ChainID(context.Background())
    if err != nil {
        return nil, err
    }
    
    auth, err := bind.NewKeyedTransactorWithChainID(privateKey, chainID)
    if err != nil {
        return nil, err
    }
    
    return &SettlementClient{
        client:   client,
        contract: contract,
        auth:     auth,
    }, nil
}

// 结算交易
func (sc *SettlementClient) SettleTrade(trade *Trade) error {
    amountIn, _ := new(big.Int).SetString(trade.AmountIn, 10)
    amountOut, _ := new(big.Int).SetString(trade.AmountOut, 10)
    
    tx, err := sc.contract.SettleTrade(
        sc.auth,
        common.HexToAddress(trade.MakerAddress),
        common.HexToAddress(trade.TakerAddress),
        common.HexToAddress(trade.TokenIn),
        common.HexToAddress(trade.TokenOut),
        amountIn,
        amountOut,
        big.NewInt(0),  // gasReimburseIn
        big.NewInt(0),  // gasReimburseOut
    )
    
    if err != nil {
        return err
    }
    
    // 等待交易确认
    receipt, err := bind.WaitMined(context.Background(), sc.client, tx)
    if err != nil {
        return err
    }
    
    if receipt.Status == 0 {
        return fmt.Errorf("交易失败")
    }
    
    // 更新成交记录的交易哈希
    trade.TxHash = tx.Hash().Hex()
    
    return nil
}
```

### 5.2 生成合约绑定

```bash
# 安装 abigen
go install github.com/ethereum/go-ethereum/cmd/abigen@latest

# 生成 Settlement 合约绑定
cd contracts
forge build

# 生成 Go 绑定
abigen --abi out/Settlement.sol/Settlement.json \
       --pkg settlement \
       --type Settlement \
       --out ../node/internal/settlement/settlement.go
```


---

## 6. 前端集成

### 6.1 订单提交

在 `frontend/src/services/orderService.ts` 中实现：

```typescript
import { ethers } from 'ethers'
import { nodePost } from '../nodeClient'

export interface OrderParams {
  tokenIn: string
  tokenOut: string
  amountIn: string
  amountOut: string
  price: string
  side: 'buy' | 'sell'
  type: 'limit' | 'market'
}

export async function submitOrder(
  params: OrderParams,
  signer: ethers.Signer
): Promise<string> {
  const address = await signer.getAddress()
  const timestamp = Math.floor(Date.now() / 1000)
  
  // 构造订单消息
  const orderMessage = {
    order_id: generateOrderID(),
    user_address: address,
    token_in: params.tokenIn,
    token_out: params.tokenOut,
    amount_in: params.amountIn,
    amount_out: params.amountOut,
    price: params.price,
    timestamp,
    side: params.side,
    type: params.type,
  }
  
  // 签名订单
  const messageHash = ethers.utils.solidityKeccak256(
    ['string', 'address', 'address', 'address', 'uint256', 'uint256', 'uint256', 'uint256'],
    [
      orderMessage.order_id,
      orderMessage.user_address,
      orderMessage.token_in,
      orderMessage.token_out,
      orderMessage.amount_in,
      orderMessage.amount_out,
      orderMessage.price,
      orderMessage.timestamp,
    ]
  )
  
  const signature = await signer.signMessage(ethers.utils.arrayify(messageHash))
  
  // 提交到 P2P 节点
  const { data } = await nodePost('/api/order/submit', {
    ...orderMessage,
    signature,
  })
  
  return orderMessage.order_id
}

export async function cancelOrder(
  orderID: string,
  signer: ethers.Signer
): Promise<void> {
  const address = await signer.getAddress()
  const timestamp = Math.floor(Date.now() / 1000)
  
  const messageHash = ethers.utils.solidityKeccak256(
    ['string', 'address', 'uint256'],
    [orderID, address, timestamp]
  )
  
  const signature = await signer.signMessage(ethers.utils.arrayify(messageHash))
  
  await nodePost('/api/order/cancel', {
    order_id: orderID,
    user_address: address,
    timestamp,
    signature,
  })
}

function generateOrderID(): string {
  return `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}
```

### 6.2 订单簿展示

在 `frontend/src/components/OrderBook.tsx` 中实现：

```typescript
import { useEffect, useState } from 'react'
import { nodeGet } from '../nodeClient'

interface OrderBookLevel {
  price: string
  amount: string
  total: string
}

export function OrderBook({ pair }: { pair: string }) {
  const [bids, setBids] = useState<OrderBookLevel[]>([])
  const [asks, setAsks] = useState<OrderBookLevel[]>([])
  
  useEffect(() => {
    const fetchOrderBook = async () => {
      try {
        const { data } = await nodeGet<{
          bids: OrderBookLevel[]
          asks: OrderBookLevel[]
        }>(`/api/orderbook/${pair}`)
        
        setBids(data.bids)
        setAsks(data.asks)
      } catch (error) {
        console.error('获取订单簿失败:', error)
      }
    }
    
    fetchOrderBook()
    const interval = setInterval(fetchOrderBook, 1000)
    
    return () => clearInterval(interval)
  }, [pair])
  
  return (
    <div className="orderbook">
      <div className="asks">
        <h3>卖单</h3>
        {asks.map((ask, i) => (
          <div key={i} className="level ask">
            <span className="price">{ask.price}</span>
            <span className="amount">{ask.amount}</span>
            <span className="total">{ask.total}</span>
          </div>
        ))}
      </div>
      
      <div className="spread">
        <span>价差: {calculateSpread(bids[0], asks[0])}</span>
      </div>
      
      <div className="bids">
        <h3>买单</h3>
        {bids.map((bid, i) => (
          <div key={i} className="level bid">
            <span className="price">{bid.price}</span>
            <span className="amount">{bid.amount}</span>
            <span className="total">{bid.total}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function calculateSpread(
  bestBid?: OrderBookLevel,
  bestAsk?: OrderBookLevel
): string {
  if (!bestBid || !bestAsk) return '-'
  const spread = parseFloat(bestAsk.price) - parseFloat(bestBid.price)
  return spread.toFixed(6)
}
```


---

## 7. 节点 API 实现

### 7.1 HTTP API 服务

在 `node/internal/api/server.go` 中实现：

```go
package api

import (
    "encoding/json"
    "net/http"
    "github.com/gorilla/mux"
)

type Server struct {
    router        *mux.Router
    matchEngine   *match.MatchEngine
    orderPublisher *sync.OrderPublisher
}

func NewServer(engine *match.MatchEngine, publisher *sync.OrderPublisher) *Server {
    s := &Server{
        router:        mux.NewRouter(),
        matchEngine:   engine,
        orderPublisher: publisher,
    }
    
    s.setupRoutes()
    return s
}

func (s *Server) setupRoutes() {
    // 提交订单
    s.router.HandleFunc("/api/order/submit", s.handleSubmitOrder).Methods("POST")
    
    // 取消订单
    s.router.HandleFunc("/api/order/cancel", s.handleCancelOrder).Methods("POST")
    
    // 获取订单簿
    s.router.HandleFunc("/api/orderbook/{pair}", s.handleGetOrderBook).Methods("GET")
    
    // 获取成交历史
    s.router.HandleFunc("/api/trades/{pair}", s.handleGetTrades).Methods("GET")
    
    // 获取用户订单
    s.router.HandleFunc("/api/orders/{address}", s.handleGetUserOrders).Methods("GET")
}

func (s *Server) handleSubmitOrder(w http.ResponseWriter, r *http.Request) {
    var order sync.Order
    if err := json.NewDecoder(r.Body).Decode(&order); err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }
    
    // 广播订单到 P2P 网络
    if err := s.orderPublisher.PublishOrder(r.Context(), &order); err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    
    json.NewEncoder(w).Encode(map[string]interface{}{
        "ok":       true,
        "order_id": order.OrderID,
    })
}

func (s *Server) handleCancelOrder(w http.ResponseWriter, r *http.Request) {
    var cancel sync.CancelOrder
    if err := json.NewDecoder(r.Body).Decode(&cancel); err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }
    
    // 广播取消到 P2P 网络
    if err := s.orderPublisher.PublishCancel(r.Context(), &cancel); err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    
    json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func (s *Server) handleGetOrderBook(w http.ResponseWriter, r *http.Request) {
    vars := mux.Vars(r)
    pair := vars["pair"]
    
    ob, exists := s.matchEngine.GetOrderBook(pair)
    if !exists {
        json.NewEncoder(w).Encode(map[string]interface{}{
            "bids": []interface{}{},
            "asks": []interface{}{},
        })
        return
    }
    
    bids := ob.GetBids(20)  // 获取前 20 档
    asks := ob.GetAsks(20)
    
    json.NewEncoder(w).Encode(map[string]interface{}{
        "bids": bids,
        "asks": asks,
    })
}

func (s *Server) Start(addr string) error {
    return http.ListenAndServe(addr, s.router)
}
```

### 7.2 在主程序中启动 API

修改 `node/cmd/node/main.go`：

```go
package main

import (
    "context"
    "log"
    "os"
    "os/signal"
    "syscall"
    
    "p2p-node/internal/api"
    "p2p-node/internal/config"
    "p2p-node/internal/match"
    "p2p-node/internal/p2p"
    "p2p-node/internal/settlement"
    "p2p-node/internal/sync"
)

func main() {
    // 加载配置
    cfg, err := config.Load("config.yaml")
    if err != nil {
        log.Fatal(err)
    }
    
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()
    
    // 初始化 P2P 节点
    host, ps, err := p2p.NewNode(ctx, cfg)
    if err != nil {
        log.Fatal(err)
    }
    
    log.Printf("节点启动 | PeerID: %s", host.ID())
    
    // 初始化订单发布器
    publisher, err := sync.NewOrderPublisher(host, ps)
    if err != nil {
        log.Fatal(err)
    }
    
    // 初始化结算客户端
    settler, err := settlement.NewSettlementClient(
        cfg.Chain.RPCURL,
        cfg.Chain.SettlementContract,
        cfg.Chain.PrivateKey,
    )
    if err != nil {
        log.Fatal(err)
    }
    
    // 初始化撮合引擎
    engine := match.NewMatchEngine(publisher, settler)
    
    // 初始化订单订阅器
    subscriber := sync.NewOrderSubscriber(ps, engine)
    if err := subscriber.Start(ctx); err != nil {
        log.Fatal(err)
    }
    
    // 启动 HTTP API
    apiServer := api.NewServer(engine, publisher)
    go func() {
        log.Printf("API 服务启动: http://localhost:8080")
        if err := apiServer.Start(":8080"); err != nil {
            log.Fatal(err)
        }
    }()
    
    // 等待退出信号
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
    <-sigCh
    
    log.Println("节点关闭中...")
}
```


---

## 8. 完整测试流程

### 8.1 启动多个节点

**终端 1（撮合节点）**：
```bash
cd node
cp config.example.yaml config.yaml
# 编辑 config.yaml，设置 node.type: match
go run ./cmd/node
```

记录输出的 PeerID 和监听地址。

**终端 2（存储节点）**：
```bash
cd node
cp config.example.yaml config2.yaml
# 编辑 config2.yaml，设置 node.type: storage, node.listen: /ip4/0.0.0.0/tcp/4002
go run ./cmd/node -config config2.yaml -port 4002 -connect <撮合节点地址>
```

**终端 3（中继节点）**：
```bash
cd node
cp config.example.yaml config3.yaml
# 编辑 config3.yaml，设置 node.type: relay, node.listen: /ip4/0.0.0.0/tcp/4003
go run ./cmd/node -config config3.yaml -port 4003 -connect <撮合节点地址>
```

### 8.2 启动前端

```bash
cd frontend
npm install
npm run dev
```

浏览器打开 http://localhost:5173

### 8.3 测试订单提交与撮合

1. **连接钱包**：点击「连接钱包」，选择 MetaMask
2. **存入资金**：在「存款」页面存入 TKA 和 TKB
3. **提交买单**：
   - 交易对：TKA/TKB
   - 类型：限价单
   - 方向：买入
   - 价格：1.5
   - 数量：100
   - 点击「提交订单」
4. **提交卖单**：
   - 交易对：TKA/TKB
   - 类型：限价单
   - 方向：卖出
   - 价格：1.5
   - 数量：50
   - 点击「提交订单」

### 8.4 验证结果

**节点日志**：
```
收到新订单: order_xxx, 交易对: TKA/TKB, 价格: 1.5
收到新订单: order_yyy, 交易对: TKA/TKB, 价格: 1.5
撮合成功: 50 TKA @ 1.5
广播成交: trade_zzz
链上结算: 0xabc123...
```

**前端**：
- 订单簿显示剩余 50 TKA 买单
- 成交历史显示 50 TKA @ 1.5 的成交记录
- 用户余额更新

**链上**：
```bash
# 查询 Settlement 事件
cast logs --address <Settlement 地址> \
  --from-block latest \
  --rpc-url https://ethereum-sepolia.publicnode.com

# 应该看到 TradeSettled 事件
```


---

## 9. 高级特性

### 9.1 订单签名验证

在 `node/internal/match/signature.go` 中实现：

```go
package match

import (
    "crypto/ecdsa"
    "fmt"
    
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/crypto"
)

func VerifyOrderSignature(order *Order) (bool, error) {
    // 构造消息哈希
    message := fmt.Sprintf(
        "%s%s%s%s%s%s%s%d",
        order.OrderID,
        order.UserAddress,
        order.TokenIn,
        order.TokenOut,
        order.AmountIn,
        order.AmountOut,
        order.Price,
        order.Timestamp,
    )
    
    hash := crypto.Keccak256Hash([]byte(message))
    
    // 解析签名
    sig := common.FromHex(order.Signature)
    if len(sig) != 65 {
        return false, fmt.Errorf("invalid signature length")
    }
    
    // 恢复公钥
    pubKey, err := crypto.SigToPub(hash.Bytes(), sig)
    if err != nil {
        return false, err
    }
    
    // 验证地址
    recoveredAddr := crypto.PubkeyToAddress(*pubKey)
    expectedAddr := common.HexToAddress(order.UserAddress)
    
    return recoveredAddr == expectedAddr, nil
}
```

### 9.2 订单过期机制

在订单结构中添加过期时间：

```go
type Order struct {
    // ... 其他字段
    ExpiresAt int64  // 过期时间戳
}

// 在撮合引擎中定期清理过期订单
func (me *MatchEngine) cleanExpiredOrders() {
    ticker := time.NewTicker(10 * time.Second)
    defer ticker.Stop()
    
    for range ticker.C {
        now := time.Now().Unix()
        
        for _, ob := range me.orderbooks {
            ob.mu.Lock()
            for id, order := range ob.orders {
                if order.ExpiresAt > 0 && order.ExpiresAt < now {
                    delete(ob.orders, id)
                    order.Status = "expired"
                }
            }
            ob.mu.Unlock()
        }
    }
}
```

### 9.3 部分成交支持

修改撮合逻辑，支持订单部分成交：

```go
func (me *MatchEngine) matchOrder(ob *OrderBook, order *Order) []*Trade {
    trades := make([]*Trade, 0)
    
    // 初始化剩余量
    if order.RemainingAmount == nil {
        order.RemainingAmount = new(big.Int)
        order.RemainingAmount.SetString(order.AmountIn, 10)
    }
    
    // 撮合逻辑...
    // 每次成交后更新 RemainingAmount
    
    return trades
}
```

### 9.4 订单优先级

支持不同类型订单的优先级：

```go
type OrderPriority int

const (
    PriorityLow    OrderPriority = 0
    PriorityNormal OrderPriority = 1
    PriorityHigh   OrderPriority = 2  // 例如：支付更高手续费
)

func (pl *PriceLevel) Less(i, j int) bool {
    // 优先级高的优先
    if pl.orders[i].Priority != pl.orders[j].Priority {
        return pl.orders[i].Priority > pl.orders[j].Priority
    }
    
    // 价格优先
    if pl.orders[i].Price != pl.orders[j].Price {
        return pl.orders[i].Price > pl.orders[j].Price
    }
    
    // 时间优先
    return pl.orders[i].Timestamp < pl.orders[j].Timestamp
}
```

### 9.5 限流与防 DDoS

在 API 层添加限流：

```go
import "golang.org/x/time/rate"

type Server struct {
    // ... 其他字段
    limiters map[string]*rate.Limiter  // IP -> 限流器
}

func (s *Server) rateLimitMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ip := r.RemoteAddr
        
        limiter, exists := s.limiters[ip]
        if !exists {
            // 每秒 10 个请求，突发 20 个
            limiter = rate.NewLimiter(10, 20)
            s.limiters[ip] = limiter
        }
        
        if !limiter.Allow() {
            http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
            return
        }
        
        next.ServeHTTP(w, r)
    })
}
```


---

## 10. WebSocket API 实现

### 10.1 添加 WebSocket 支持

在 `node/internal/api/websocket.go` 中实现：

```go
package api

import (
    "encoding/json"
    "log"
    "net/http"
    "sync"
    
    "github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
    CheckOrigin: func(r *http.Request) bool {
        return true  // 生产环境需要验证 origin
    },
}

type WSClient struct {
    conn   *websocket.Conn
    send   chan []byte
    server *WSServer
}

type WSServer struct {
    clients    map[*WSClient]bool
    broadcast  chan []byte
    register   chan *WSClient
    unregister chan *WSClient
    mu         sync.RWMutex
}

func NewWSServer() *WSServer {
    return &WSServer{
        clients:    make(map[*WSClient]bool),
        broadcast:  make(chan []byte, 256),
        register:   make(chan *WSClient),
        unregister: make(chan *WSClient),
    }
}

func (s *WSServer) Run() {
    for {
        select {
        case client := <-s.register:
            s.mu.Lock()
            s.clients[client] = true
            s.mu.Unlock()
            log.Printf("WebSocket 客户端连接，当前: %d", len(s.clients))
            
        case client := <-s.unregister:
            s.mu.Lock()
            if _, ok := s.clients[client]; ok {
                delete(s.clients, client)
                close(client.send)
            }
            s.mu.Unlock()
            log.Printf("WebSocket 客户端断开，当前: %d", len(s.clients))
            
        case message := <-s.broadcast:
            s.mu.RLock()
            for client := range s.clients {
                select {
                case client.send <- message:
                default:
                    close(client.send)
                    delete(s.clients, client)
                }
            }
            s.mu.RUnlock()
        }
    }
}

// 广播订单簿更新
func (s *WSServer) BroadcastOrderBookUpdate(pair string, data interface{}) {
    msg := map[string]interface{}{
        "type": "orderbook_update",
        "pair": pair,
        "data": data,
    }
    
    jsonData, _ := json.Marshal(msg)
    s.broadcast <- jsonData
}

// 广播成交
func (s *WSServer) BroadcastTrade(trade *sync.Trade) {
    msg := map[string]interface{}{
        "type":  "trade",
        "data":  trade,
    }
    
    jsonData, _ := json.Marshal(msg)
    s.broadcast <- jsonData
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
    conn, err := upgrader.Upgrade(w, r, nil)
    if err != nil {
        log.Printf("WebSocket 升级失败: %v", err)
        return
    }
    
    client := &WSClient{
        conn:   conn,
        send:   make(chan []byte, 256),
        server: s.wsServer,
    }
    
    s.wsServer.register <- client
    
    // 启动读写协程
    go client.writePump()
    go client.readPump()
}

func (c *WSClient) readPump() {
    defer func() {
        c.server.unregister <- c
        c.conn.Close()
    }()
    
    for {
        _, message, err := c.conn.ReadMessage()
        if err != nil {
            break
        }
        
        // 处理客户端消息（如订阅特定交易对）
        var msg map[string]interface{}
        if err := json.Unmarshal(message, &msg); err != nil {
            continue
        }
        
        // 处理订阅请求等
        log.Printf("收到 WebSocket 消息: %v", msg)
    }
}

func (c *WSClient) writePump() {
    defer c.conn.Close()
    
    for message := range c.send {
        if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
            break
        }
    }
}
```

### 10.2 在 API Server 中集成 WebSocket

修改 `node/internal/api/server.go`：

```go
type Server struct {
    router         *mux.Router
    matchEngine    *match.MatchEngine
    orderPublisher *sync.OrderPublisher
    wsServer       *WSServer  // 新增
}

func NewServer(engine *match.MatchEngine, publisher *sync.OrderPublisher) *Server {
    s := &Server{
        router:         mux.NewRouter(),
        matchEngine:    engine,
        orderPublisher: publisher,
        wsServer:       NewWSServer(),
    }
    
    // 启动 WebSocket 服务
    go s.wsServer.Run()
    
    s.setupRoutes()
    return s
}

func (s *Server) setupRoutes() {
    // ... 现有路由
    
    // WebSocket 端点
    s.router.HandleFunc("/ws", s.handleWebSocket)
    
    // 发布订单端点（供前端调用）
    s.router.HandleFunc("/api/publish-order", s.handlePublishOrder).Methods("POST")
}

func (s *Server) handlePublishOrder(w http.ResponseWriter, r *http.Request) {
    var order sync.Order
    if err := json.NewDecoder(r.Body).Decode(&order); err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }
    
    // 验证签名
    if valid, err := match.VerifyOrderSignature(&order); !valid || err != nil {
        http.Error(w, "invalid signature", http.StatusUnauthorized)
        return
    }
    
    // 广播到 P2P 网络
    if err := s.orderPublisher.PublishOrder(r.Context(), &order); err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    
    json.NewEncoder(w).Encode(map[string]interface{}{
        "ok":       true,
        "order_id": order.OrderID,
    })
}

// 在撮合引擎中调用 WebSocket 广播
func (me *MatchEngine) OnNewOrder(order *Order) error {
    // ... 现有逻辑
    
    // 广播订单簿更新
    if me.wsServer != nil {
        ob := me.orderbooks[order.Pair]
        me.wsServer.BroadcastOrderBookUpdate(order.Pair, map[string]interface{}{
            "bids": ob.GetBids(20),
            "asks": ob.GetAsks(20),
        })
    }
    
    return nil
}
```


---

## 11. 前端 WebSocket 集成

### 11.1 WebSocket 客户端

在 `frontend/src/services/wsClient.ts` 中实现：

```typescript
export type WSMessageType = 'orderbook_update' | 'trade' | 'order_status'

export interface WSMessage {
  type: WSMessageType
  pair?: string
  data: any
}

export class P2PWebSocketClient {
  private ws: WebSocket | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private listeners: Map<WSMessageType, Set<(data: any) => void>> = new Map()
  private url: string
  
  constructor(url: string) {
    this.url = url
  }
  
  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return
    
    console.log('连接 P2P 节点 WebSocket:', this.url)
    this.ws = new WebSocket(this.url)
    
    this.ws.onopen = () => {
      console.log('P2P WebSocket 已连接')
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
    }
    
    this.ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data)
        this.handleMessage(msg)
      } catch (error) {
        console.error('解析 WebSocket 消息失败:', error)
      }
    }
    
    this.ws.onerror = (error) => {
      console.error('WebSocket 错误:', error)
    }
    
    this.ws.onclose = () => {
      console.log('WebSocket 断开，5 秒后重连...')
      this.reconnectTimer = setTimeout(() => this.connect(), 5000)
    }
  }
  
  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }
  
  subscribe(type: WSMessageType, callback: (data: any) => void) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set())
    }
    this.listeners.get(type)!.add(callback)
    
    return () => {
      this.listeners.get(type)?.delete(callback)
    }
  }
  
  private handleMessage(msg: WSMessage) {
    const callbacks = this.listeners.get(msg.type)
    if (callbacks) {
      callbacks.forEach(cb => cb(msg.data))
    }
  }
  
  send(data: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }
}

// 全局实例
export const p2pWS = new P2PWebSocketClient(
  import.meta.env.VITE_P2P_WS_URL || 'ws://localhost:8080/ws'
)
```

### 11.2 更新配置文件

在 `frontend/src/config.ts` 中添加：

```typescript
export const P2P_CONFIG = {
  WS_URL: import.meta.env.VITE_P2P_WS_URL || 'ws://localhost:8080/ws',
  API_URL: import.meta.env.VITE_P2P_API_URL || 'http://localhost:8080',
}
```

在 `frontend/.env` 中添加：

```env
VITE_P2P_WS_URL=ws://localhost:8080/ws
VITE_P2P_API_URL=http://localhost:8080
```

### 11.3 实时订单簿组件

更新 `frontend/src/components/OrderBook.tsx`：

```typescript
import { useEffect, useState } from 'react'
import { p2pWS } from '../services/wsClient'

interface OrderBookLevel {
  price: string
  amount: string
  total: string
}

interface OrderBookData {
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
}

export function OrderBook({ pair }: { pair: string }) {
  const [orderBook, setOrderBook] = useState<OrderBookData>({
    bids: [],
    asks: [],
  })
  
  useEffect(() => {
    // 连接 WebSocket
    p2pWS.connect()
    
    // 订阅订单簿更新
    const unsubscribe = p2pWS.subscribe('orderbook_update', (data) => {
      if (data.pair === pair || !data.pair) {
        setOrderBook({
          bids: data.bids || [],
          asks: data.asks || [],
        })
      }
    })
    
    // 初始加载
    fetch(`${P2P_CONFIG.API_URL}/api/orderbook/${pair}`)
      .then(r => r.json())
      .then(data => setOrderBook(data))
      .catch(console.error)
    
    return () => {
      unsubscribe()
    }
  }, [pair])
  
  const spread = orderBook.bids[0] && orderBook.asks[0]
    ? (parseFloat(orderBook.asks[0].price) - parseFloat(orderBook.bids[0].price)).toFixed(6)
    : '-'
  
  return (
    <div className="orderbook">
      <h2>订单簿 - {pair}</h2>
      
      <div className="asks">
        <div className="header">
          <span>价格</span>
          <span>数量</span>
          <span>累计</span>
        </div>
        {orderBook.asks.slice().reverse().map((ask, i) => (
          <div key={i} className="level ask">
            <span className="price">{parseFloat(ask.price).toFixed(6)}</span>
            <span className="amount">{parseFloat(ask.amount).toFixed(4)}</span>
            <span className="total">{parseFloat(ask.total).toFixed(4)}</span>
          </div>
        ))}
      </div>
      
      <div className="spread">
        <span className="label">价差:</span>
        <span className="value">{spread}</span>
      </div>
      
      <div className="bids">
        {orderBook.bids.map((bid, i) => (
          <div key={i} className="level bid">
            <span className="price">{parseFloat(bid.price).toFixed(6)}</span>
            <span className="amount">{parseFloat(bid.amount).toFixed(4)}</span>
            <span className="total">{parseFloat(bid.total).toFixed(4)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
```

### 11.4 实时成交组件

在 `frontend/src/components/TradeHistory.tsx` 中实现：

```typescript
import { useEffect, useState } from 'react'
import { p2pWS } from '../services/wsClient'

interface Trade {
  trade_id: string
  price: string
  amount: string
  side: 'buy' | 'sell'
  timestamp: number
  tx_hash?: string
}

export function TradeHistory({ pair }: { pair: string }) {
  const [trades, setTrades] = useState<Trade[]>([])
  
  useEffect(() => {
    p2pWS.connect()
    
    // 订阅实时成交
    const unsubscribe = p2pWS.subscribe('trade', (trade) => {
      setTrades(prev => [trade, ...prev].slice(0, 50))
    })
    
    // 加载历史成交
    fetch(`${P2P_CONFIG.API_URL}/api/trades/${pair}?limit=50`)
      .then(r => r.json())
      .then(data => setTrades(data.trades || []))
      .catch(console.error)
    
    return () => unsubscribe()
  }, [pair])
  
  return (
    <div className="trade-history">
      <h3>最近成交</h3>
      <div className="trades">
        {trades.map(trade => (
          <div key={trade.trade_id} className={`trade ${trade.side}`}>
            <span className="price">{parseFloat(trade.price).toFixed(6)}</span>
            <span className="amount">{parseFloat(trade.amount).toFixed(4)}</span>
            <span className="time">
              {new Date(trade.timestamp * 1000).toLocaleTimeString()}
            </span>
            {trade.tx_hash && (
              <a 
                href={`https://sepolia.etherscan.io/tx/${trade.tx_hash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="tx-link"
              >
                ⛓️
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
```


---

## 12. EIP-712 订单签名

### 12.1 前端签名实现

在 `frontend/src/services/orderSigning.ts` 中实现：

```typescript
import { ethers } from 'ethers'

// EIP-712 域分隔符
const DOMAIN = {
  name: 'P2P DEX',
  version: '1',
  chainId: 11155111,  // Sepolia
  verifyingContract: '0x0000000000000000000000000000000000000000',  // 可选
}

// 订单类型定义
const ORDER_TYPES = {
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
}

export interface OrderData {
  orderId: string
  userAddress: string
  tokenIn: string
  tokenOut: string
  amountIn: string
  amountOut: string
  price: string
  timestamp: number
  expiresAt: number
}

export async function signOrder(
  order: OrderData,
  signer: ethers.Signer
): Promise<string> {
  // 使用 EIP-712 签名
  const signature = await signer._signTypedData(DOMAIN, ORDER_TYPES, order)
  return signature
}

export async function signCancelOrder(
  orderId: string,
  userAddress: string,
  timestamp: number,
  signer: ethers.Signer
): Promise<string> {
  const CANCEL_TYPES = {
    CancelOrder: [
      { name: 'orderId', type: 'string' },
      { name: 'userAddress', type: 'address' },
      { name: 'timestamp', type: 'uint256' },
    ],
  }
  
  const signature = await signer._signTypedData(DOMAIN, CANCEL_TYPES, {
    orderId,
    userAddress,
    timestamp,
  })
  
  return signature
}

// 生成订单 ID
export function generateOrderId(): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(2, 11)
  return `order_${timestamp}_${random}`
}
```

### 12.2 节点端签名验证

在 `node/internal/match/eip712.go` 中实现：

```go
package match

import (
    "fmt"
    "math/big"
    
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/common/math"
    "github.com/ethereum/go-ethereum/crypto"
    "github.com/ethereum/go-ethereum/signer/core/apitypes"
)

var (
    domainSeparator = apitypes.TypedDataDomain{
        Name:    "P2P DEX",
        Version: "1",
        ChainId: math.NewHexOrDecimal256(11155111), // Sepolia
    }
    
    orderTypes = apitypes.Types{
        "EIP712Domain": {
            {Name: "name", Type: "string"},
            {Name: "version", Type: "string"},
            {Name: "chainId", Type: "uint256"},
        },
        "Order": {
            {Name: "orderId", Type: "string"},
            {Name: "userAddress", Type: "address"},
            {Name: "tokenIn", Type: "address"},
            {Name: "tokenOut", Type: "address"},
            {Name: "amountIn", Type: "uint256"},
            {Name: "amountOut", Type: "uint256"},
            {Name: "price", Type: "uint256"},
            {Name: "timestamp", Type: "uint256"},
            {Name: "expiresAt", Type: "uint256"},
        },
    }
)

func VerifyOrderSignatureEIP712(order *Order) (bool, error) {
    // 构造 TypedData
    amountIn := new(big.Int)
    amountIn.SetString(order.AmountIn, 10)
    
    amountOut := new(big.Int)
    amountOut.SetString(order.AmountOut, 10)
    
    price := new(big.Int)
    price.SetString(order.Price, 10)
    
    typedData := apitypes.TypedData{
        Types:       orderTypes,
        PrimaryType: "Order",
        Domain:      domainSeparator,
        Message: apitypes.TypedDataMessage{
            "orderId":     order.OrderID,
            "userAddress": order.UserAddress,
            "tokenIn":     order.TokenIn,
            "tokenOut":    order.TokenOut,
            "amountIn":    amountIn.String(),
            "amountOut":   amountOut.String(),
            "price":       price.String(),
            "timestamp":   fmt.Sprintf("%d", order.Timestamp),
            "expiresAt":   fmt.Sprintf("%d", order.ExpiresAt),
        },
    }
    
    // 计算 EIP-712 哈希
    hash, err := typedData.HashStruct("Order", typedData.Message)
    if err != nil {
        return false, err
    }
    
    domainHash, err := typedData.HashStruct("EIP712Domain", typedData.Domain.Map())
    if err != nil {
        return false, err
    }
    
    // \x19\x01 + domainHash + structHash
    rawData := []byte(fmt.Sprintf("\x19\x01%s%s", string(domainHash), string(hash)))
    finalHash := crypto.Keccak256Hash(rawData)
    
    // 解析签名
    sig := common.FromHex(order.Signature)
    if len(sig) != 65 {
        return false, fmt.Errorf("invalid signature length: %d", len(sig))
    }
    
    // 调整 v 值（以太坊签名格式）
    if sig[64] >= 27 {
        sig[64] -= 27
    }
    
    // 恢复公钥
    pubKey, err := crypto.SigToPub(finalHash.Bytes(), sig)
    if err != nil {
        return false, err
    }
    
    // 验证地址
    recoveredAddr := crypto.PubkeyToAddress(*pubKey)
    expectedAddr := common.HexToAddress(order.UserAddress)
    
    return recoveredAddr == expectedAddr, nil
}
```


---

## 13. Docker 完整部署

### 13.1 更新 docker-compose.yml

项目根目录的 `docker-compose.yml` 已更新为完整部署配置，包含：
- 撮合节点（match-node）：端口 4001（P2P）、8080（API + WebSocket）
- 存储节点（storage-node）：端口 4002（P2P）、8081（API）
- 中继节点（relay-node）：端口 4003（P2P）
- 前端（frontend）：端口 5173

### 13.2 启动完整系统

```bash
# 在项目根目录
docker-compose up --build
```

这会启动所有服务，节点之间自动连接，前端自动连接到撮合节点的 WebSocket。

### 13.3 访问服务

- **前端**：http://localhost:5173
- **撮合节点 API**：http://localhost:8080
- **存储节点 API**：http://localhost:8081
- **WebSocket**：ws://localhost:8080/ws

### 13.4 单独启动某个服务

```bash
# 只启动撮合节点
docker-compose up match-node

# 只启动前端
docker-compose up frontend

# 扩展中继节点到 3 个
docker-compose up --scale relay-node=3
```


---

## 14. 性能优化与扩展

### 14.1 GossipSub 性能

GossipSub 适合广播场景（1000+ peers），但对于大订单簿：

**优化方案**：
- 使用 DHT 存储订单簿快照
- 订单增量更新而非全量广播
- 按交易对分主题（如 `/p2p-exchange/order/new/TKA-TKB`）

```go
// 按交易对分主题
func GetOrderTopic(pair string) string {
    return fmt.Sprintf("/p2p-exchange/order/new/%s", pair)
}
```

### 14.2 订单隐私

当前订单广播可见，可使用 zk-SNARK 隐藏细节：

```go
// 订单承诺（隐藏价格和数量）
type OrderCommitment struct {
    OrderID   string
    Trader    string
    Pair      string
    Commitment string // zk 承诺
    Proof      string // zk 证明
}
```

### 14.3 激励机制

节点运行者通过以下方式获得奖励：

1. **中继节点**：转发字节数 × 费率
2. **撮合节点**：成交笔数 × 费率
3. **存储节点**：存储容量 × 时间

配置在 `ContributorReward` 合约中，按周期分配。

### 14.4 主网部署

**Polygon 推荐**（低 gas）：

```bash
# 1. 部署合约到 Polygon
cd contracts
forge script script/Deploy.s.sol:Deploy --rpc-url $POLYGON_RPC_URL --broadcast

# 2. 更新前端配置
# 在 frontend/src/config.ts 中填入 POLYGON 合约地址

# 3. 构建前端
cd frontend
npm run build:polygon

# 4. 更新节点配置
# 在 node/config.yaml 中设置 chain.rpc_url 为 Polygon RPC
```

### 14.5 Bootstrap 节点

生产环境需要稳定的 Bootstrap 节点：

```yaml
# config.yaml
network:
  bootstrap:
    - /ip4/YOUR_PUBLIC_IP/tcp/4001/p2p/YOUR_PEER_ID
    - /dns4/bootstrap.p2p-dex.io/tcp/4001/p2p/BOOTSTRAP_PEER_ID
```

**多区域部署**：
- 美国：AWS us-east-1
- 欧洲：AWS eu-west-1
- 亚洲：AWS ap-southeast-1

每个区域至少 1 个 Bootstrap 节点，确保全球连通性。


---

## 15. 安全与风险

### 15.1 防 Sybil 攻击

**当前实现**：
- 中继节点限流（按 peer 限制字节数和消息数）
- 信誉系统（记录违规次数）

**增强方案**：
- Stake 机制：节点需质押代币才能参与
- CAPTCHA：用户下单前需验证
- 身份验证：使用 DID（去中心化身份）

```go
// Stake 验证
func (me *MatchEngine) OnNewOrder(order *Order) error {
    // 检查用户是否已质押
    staked, err := me.checkStake(order.Trader)
    if err != nil || !staked {
        return fmt.Errorf("insufficient stake")
    }
    // ... 继续处理
}
```

### 15.2 订单签名验证

所有订单必须使用 EIP-712 签名，节点验证后才接受：

```go
// 在撮合引擎中验证
if valid, err := VerifyOrderSignature(order); !valid || err != nil {
    log.Printf("订单签名无效: %v", err)
    return nil
}
```

### 15.3 链上结算安全

Settlement 合约已实现：
- 手续费上限（防止恶意高费用）
- Relayer 白名单（只有授权节点可代付 gas）
- 金额验证（防止溢出）

### 15.4 前端安全

- 使用 HTTPS（生产环境必须）
- 验证合约地址（防止钓鱼）
- 限制交易金额（防止误操作）
- 显示交易预览（用户确认后再签名）


---

## 16. 参考资源

### 16.1 libp2p 资源

- **官方文档**：https://docs.libp2p.io/
- **Go 示例**：https://github.com/libp2p/go-libp2p-examples
- **GossipSub 规范**：https://github.com/libp2p/specs/tree/master/pubsub/gossipsub
- **DHT 规范**：https://github.com/libp2p/specs/tree/master/kad-dht

### 16.2 P2P DEX 参考

- **Unison**：https://github.com/unison-network
- **Beam**：https://github.com/BeamMW/beam
- **0x Protocol**：https://0x.org/docs

### 16.3 以太坊开发

- **go-ethereum**：https://geth.ethereum.org/docs/developers/dapp-developer
- **EIP-712**：https://eips.ethereum.org/EIPS/eip-712
- **Foundry**：https://book.getfoundry.sh/

### 16.4 项目文档

- **概念设计**：[docs/概念设计文档.md](概念设计文档.md)
- **技术架构**：[docs/技术架构说明.md](技术架构说明.md)
- **API 接口**：[docs/API-接口说明.md](API-接口说明.md)
- **部署指南**：[docs/部署与使用说明.md](部署与使用说明.md)

---

## 总结

通过本指南，你已经完成了 P2P 节点与交易撮合的深度整合：

1. ✅ **P2P 网络**：libp2p + GossipSub 实现订单广播
2. ✅ **订单协议**：Protobuf 定义 + EIP-712 签名
3. ✅ **撮合引擎**：Price-Time 优先算法
4. ✅ **链上结算**：Settlement 合约集成
5. ✅ **前端集成**：WebSocket 实时订单簿
6. ✅ **Docker 部署**：一键启动完整系统

**下一步**：
- 测试多节点场景（3+ 节点）
- 优化性能（订单簿索引、缓存）
- 添加更多交易对
- 部署到主网（Polygon 推荐）
- 实现高级功能（止损单、冰山订单等）

**获取帮助**：
- GitHub Issues：https://github.com/P2P-P2P/p2p/issues
- Discord：（待建立）
- 文档：https://github.com/P2P-P2P/p2p/tree/main/docs
