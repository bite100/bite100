package sync

import (
	"context"
	"encoding/json"
	"log"
	"time"

	pubsub "github.com/libp2p/go-libp2p-pubsub"

	"github.com/P2P-P2P/p2p/node/internal/relay"
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
	pubsub     *pubsub.PubSub
	handler    OrderHandler
	limiter    *relay.Limiter
	reputation *relay.Reputation
}

// NewOrderSubscriber 创建订单订阅器
func NewOrderSubscriber(ps *pubsub.PubSub, handler OrderHandler) *OrderSubscriber {
	return NewOrderSubscriberWithSecurity(ps, handler, nil, nil)
}

// NewOrderSubscriberWithSecurity 创建带限流与信誉记录的订单订阅器
// limiter 与 reputation 可为 nil：nil 表示不启用对应功能。
func NewOrderSubscriberWithSecurity(ps *pubsub.PubSub, handler OrderHandler, limiter *relay.Limiter, reputation *relay.Reputation) *OrderSubscriber {
	return &OrderSubscriber{
		pubsub:     ps,
		handler:    handler,
		limiter:    limiter,
		reputation: reputation,
	}
}

// allowAndRecord 针对单条消息进行限流与信誉记录。
// 返回 false 表示该消息应被丢弃，不再继续处理。
func (os *OrderSubscriber) allowAndRecord(topic string, msg *pubsub.Message) bool {
	if os.limiter == nil && os.reputation == nil {
		return true
	}
	from := msg.GetFrom()
	size := uint64(len(msg.Data))

	// 限流：超过每 peer 限额则直接丢弃，并记一次违规
	if os.limiter != nil && !os.limiter.Allow(from, size) {
		if os.reputation != nil {
			os.reputation.RecordViolation(from)
		}
		log.Printf("[relay] peer=%s 超出限流，丢弃消息 topic=%s size=%d bytes", from, topic, size)
		return false
	}

	// 信誉记录：正常转发记入 bytes 与最近活跃时间
	if os.reputation != nil {
		os.reputation.RecordRelayed(from, size)
	}
	return true
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

			// Spam 防护：按 peer 速率限制 + 信誉记录
			if !os.allowAndRecord(TopicOrderNew, msg) {
				continue
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

			if !os.allowAndRecord(TopicOrderCancel, msg) {
				continue
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

			if !os.allowAndRecord(TopicTradeExecuted, msg) {
				continue
			}
			
			var trade storage.Trade
			if err := json.Unmarshal(msg.Data, &trade); err != nil {
				continue
			}
			
			os.handler.OnTradeExecuted(&trade)
		}
	}()
	
	// 定期清理过期的限流窗口与信誉记录，避免内存无限增长（每 10 分钟执行一次）
	if os.limiter != nil || os.reputation != nil {
		go func() {
			ticker := time.NewTicker(10 * time.Minute)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					if os.limiter != nil {
						os.limiter.Prune(15 * time.Minute)
					}
					if os.reputation != nil {
						os.reputation.Prune(24 * time.Hour)
					}
				}
			}
		}()
	}

	return nil
}
