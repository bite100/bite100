# P2P DEX Go SDK

P2P DEX 的 Go SDK 示例，展示如何与节点 API 交互。

## 安装

```bash
go get github.com/P2P-P2P/p2p/sdk/go
```

## 使用示例

### 1. 查询订单簿

```go
package main

import (
    "encoding/json"
    "fmt"
    "net/http"
    "io"
)

type OrderbookResponse struct {
    Pair string  `json:"pair"`
    Bids []Order `json:"bids"`
    Asks []Order `json:"asks"`
}

type Order struct {
    OrderID   string `json:"orderId"`
    Trader    string `json:"trader"`
    Pair      string `json:"pair"`
    Side      string `json:"side"`
    Price     string `json:"price"`
    Amount    string `json:"amount"`
    CreatedAt int64  `json:"createdAt"`
}

func main() {
    // 查询订单簿
    resp, err := http.Get("http://localhost:8080/api/orderbook?pair=TKA/TKB")
    if err != nil {
        panic(err)
    }
    defer resp.Body.Close()

    body, err := io.ReadAll(resp.Body)
    if err != nil {
        panic(err)
    }

    var orderbook OrderbookResponse
    if err := json.Unmarshal(body, &orderbook); err != nil {
        panic(err)
    }

    fmt.Printf("买盘: %d 档\n", len(orderbook.Bids))
    fmt.Printf("卖盘: %d 档\n", len(orderbook.Asks))
}
```

### 2. 查询成交记录

```go
type Trade struct {
    TradeID      string `json:"tradeId"`
    Pair         string `json:"pair"`
    MakerOrderID string `json:"makerOrderID"`
    TakerOrderID string `json:"takerOrderID"`
    Price        string `json:"price"`
    Amount       string `json:"amount"`
    Timestamp    int64  `json:"timestamp"`
}

func getTrades(pair string, limit int) ([]Trade, error) {
    url := fmt.Sprintf("http://localhost:8080/api/trades?pair=%s&limit=%d", pair, limit)
    resp, err := http.Get(url)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    body, err := io.ReadAll(resp.Body)
    if err != nil {
        return nil, err
    }

    var trades []Trade
    if err := json.Unmarshal(body, &trades); err != nil {
        return nil, err
    }

    return trades, nil
}
```

### 3. 提交订单

```go
func placeOrder(order Order) error {
    data, err := json.Marshal(order)
    if err != nil {
        return err
    }

    resp, err := http.Post(
        "http://localhost:8080/api/order",
        "application/json",
        bytes.NewBuffer(data),
    )
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        body, _ := io.ReadAll(resp.Body)
        return fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(body))
    }

    return nil
}
```

## 完整示例

见 [examples/](./examples/) 目录。

## 注意事项

1. 订单签名需要使用 EIP-712，Go 端可以使用 `go-ethereum` 的 `signer/core` 包
2. 建议使用 `context` 设置请求超时
3. 多节点配置时，应依次尝试连接
