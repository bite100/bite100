package match

import (
	"log"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// RestoreOrdersFromStore 从存储恢复 open/partial 订单到撮合引擎。
// 节点重启后调用，使订单簿从本地 DB 恢复；已过期订单由 AddOrder 自动跳过（OrderExpired）。
// 第二十六轮补丁：回簿前先按成交表重算已成交量——已全额成交却仍为 open 的
// 订单（如旧二进制下撮合后 Filled 从未回写者）跳过、不再回簿；部分成交者
// 按剩余量回簿。与 cmd/node 的 restoreBookOrder 同一规则，两路任一独立调
// 用都不得把死单接回盘口。
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
			if restoreOne(engine, store, o) {
				restored++
			}
		}
		for _, o := range asks {
			if restoreOne(engine, store, o) {
				restored++
			}
		}
	}
	if restored > 0 {
		log.Printf("[restore] 从存储恢复 %d 笔订单到撮合引擎", restored)
	}
	return nil
}

// restoreOne 回簿一笔订单：已全额成交者跳过，部分成交者按重算后的 Filled 接回。
func restoreOne(engine *Engine, store *storage.DB, o *storage.Order) bool {
	filled, status, err := store.RecomputeOrderFill(o.OrderID)
	if err != nil {
		log.Printf("[restore] 订单 %s 成交量对账失败（按库内值回簿）: %v", o.OrderID, err)
	} else if status == "filled" {
		log.Printf("[restore] 订单 %s 已全额成交（filled=%s），跳过回簿", o.OrderID, filled)
		return false
	} else {
		o.Filled = filled
	}
	return engine.AddOrder(o)
}
