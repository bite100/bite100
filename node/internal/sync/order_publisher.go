package sync

import (
	"context"
	"encoding/json"

	"github.com/libp2p/go-libp2p/core/host"
	pubsub "github.com/libp2p/go-libp2p-pubsub"
	
	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// OrderPublisher 订单发布器
type OrderPublisher struct {
	host   host.Host
	pubsub *pubsub.PubSub
	topics map[string]*pubsub.Topic
}

// NewOrderPublisher 创建订单发布器
func NewOrderPublisher(h host.Host, ps *pubsub.PubSub) (*OrderPublisher, error) {
	op := &OrderPublisher{
		host:   h,
		pubsub: ps,
		topics: make(map[string]*pubsub.Topic),
	}
	
	// 预先加入主题
	topicNames := []string{
		TopicOrderNew,
		TopicOrderCancel,
		TopicTradeExecuted,
		TopicSyncOrderbook,
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

// PublishOrder 广播新订单
func (op *OrderPublisher) PublishOrder(ctx context.Context, order *storage.Order) error {
	data, err := json.Marshal(order)
	if err != nil {
		return err
	}
	
	topic := op.topics[TopicOrderNew]
	return topic.Publish(ctx, data)
}

// PublishCancel 广播取消订单
func (op *OrderPublisher) PublishCancel(ctx context.Context, cancel *CancelRequest) error {
	data, err := json.Marshal(cancel)
	if err != nil {
		return err
	}
	
	topic := op.topics[TopicOrderCancel]
	return topic.Publish(ctx, data)
}

// PublishTrade 广播成交
func (op *OrderPublisher) PublishTrade(ctx context.Context, trade *storage.Trade) error {
	data, err := json.Marshal(trade)
	if err != nil {
		return err
	}
	
	topic := op.topics[TopicTradeExecuted]
	return topic.Publish(ctx, data)
}

// PublishOrderbookSnapshot 广播订单簿快照
func (op *OrderPublisher) PublishOrderbookSnapshot(ctx context.Context, snapshot *storage.OrderbookSnapshot) error {
	data, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	topic := op.topics[TopicSyncOrderbook]
	return topic.Publish(ctx, data)
}

// PublishRaw 按主题名直接发布原始字节（供 API 回调等使用）
func (op *OrderPublisher) PublishRaw(ctx context.Context, topic string, data []byte) error {
	t, ok := op.topics[topic]
	if !ok {
		return nil // 未加入的主题忽略，避免 API 报错
	}
	return t.Publish(ctx, data)
}
