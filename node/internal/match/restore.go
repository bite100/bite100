package match

import (
	"log"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// RestoreOrdersFromStore 从存储恢复 open/partial 订单到撮合引擎。
// 节点重启后调用，使订单簿从本地 DB 恢复；已过期订单由 AddOrder 自动跳过（OrderExpired）。
func RestoreOrdersFromStore(engine *Engine, store *storage.DB) error {
	if engine == nil || store == nil {
		return nil
	}
	pairs, err := store.ListPairsWithOpenOrders()
	if err != nil {
		return err
	}
	restored := 0
	for _, pair := range pairs {
		bids, asks, err := store.ListOrdersOpenByPair(pair, 500)
		if err != nil {
			log.Printf("[restore] ListOrdersOpenByPair %s: %v", pair, err)
			continue
		}
		engine.EnsurePair(pair)
		for _, o := range bids {
			if engine.AddOrder(o) {
				restored++
			}
		}
		for _, o := range asks {
			if engine.AddOrder(o) {
				restored++
			}
		}
	}
	if restored > 0 {
		log.Printf("[restore] 从存储恢复 %d 笔订单到撮合引擎", restored)
	}
	return nil
}
