package sync

import (
	"sync"

	pubsub "github.com/libp2p/go-libp2p-pubsub"
)

// go-libp2p-pubsub v0.19 起，同一 PubSub 内对同一 topic 重复 Join 会返回
// "topic already exists" 错误并给出 nil 句柄。发布器（OrderPublisher）与
// 订阅器（OrderSubscriber）需要共用同一批 topic 句柄，故在包内做一层按
// (PubSub, topic) 去重的 Join 缓存。本进程内 topic 从不关闭，缓存与进程同寿。
var topicJoins = struct {
	sync.Mutex
	byPubSub map[*pubsub.PubSub]map[string]*pubsub.Topic
}{byPubSub: make(map[*pubsub.PubSub]map[string]*pubsub.Topic)}

// joinTopicOnce 返回该 PubSub 上指定 topic 的共享句柄（首次调用时真正 Join）。
func joinTopicOnce(ps *pubsub.PubSub, name string) (*pubsub.Topic, error) {
	topicJoins.Lock()
	defer topicJoins.Unlock()
	byName, ok := topicJoins.byPubSub[ps]
	if !ok {
		byName = make(map[string]*pubsub.Topic)
		topicJoins.byPubSub[ps] = byName
	}
	if t, ok := byName[name]; ok {
		return t, nil
	}
	t, err := ps.Join(name)
	if err != nil {
		return nil, err
	}
	byName[name] = t
	return t, nil
}
