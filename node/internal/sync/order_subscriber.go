package sync

import (
	"context"
	"encoding/json"
	"log"
	
	pubsub "github.com/libp2p/go-libp2p-pubsub"
	
	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// OrderHandler 订单处理接口
type OrderHandler interface {
	OnNewOrder(order *storage.Order) error
	OnCancelOrder(cancel *CancelRequest) error
	OnTradeExecuted(trade *storage.Trade) error
}

// OrderSubscriber 订单订阅器
type OrderSubscriber struct {
	pubsub  *pubsub.PubSub
	handler OrderHandler
}

// NewOrderSubscriber 创建订单订阅器
func NewOrderSubscriber(ps *pubsub.PubSub, handler OrderHandler) *OrderSubscriber {
	return &OrderSubscriber{
		pubsub:  ps,
		handler: handler,
	}
}

// Start 启动订阅
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
	topic, err := os.pubsub.Join(TopicOrderNew)
	if err != nil {
		return err
	}
	
	sub, err := topic.Subscribe()
	if err != nil {
		return err
	}
	
	go func() {
		defer sub.Cancel()
		for {
			msg, err := sub.Next(ctx)
			if err != nil {
				log.Printf("订阅新订单错误: %v", err)
				return
			}
			
			var order storage.Order
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
	topic, err := os.pubsub.Join(TopicOrderCancel)
	if err != nil {
		return err
	}
	
	sub, err := topic.Subscribe()
	if err != nil {
		return err
	}
	
	go func() {
		defer sub.Cancel()
		for {
			msg, err := sub.Next(ctx)
			if err != nil {
				return
			}
			
			var cancel CancelRequest
			if err := json.Unmarshal(msg.Data, &cancel); err != nil {
				continue
			}
			
			os.handler.OnCancelOrder(&cancel)
		}
	}()
	
	return nil
}

func (os *OrderSubscriber) subscribeTradeExecuted(ctx context.Context) error {
	topic, err := os.pubsub.Join(TopicTradeExecuted)
	if err != nil {
		return err
	}
	
	sub, err := topic.Subscribe()
	if err != nil {
		return err
	}
	
	go func() {
		defer sub.Cancel()
		for {
			msg, err := sub.Next(ctx)
			if err != nil {
				return
			}
			
			var trade storage.Trade
			if err := json.Unmarshal(msg.Data, &trade); err != nil {
				continue
			}
			
			os.handler.OnTradeExecuted(&trade)
		}
	}()
	
	return nil
}
