package storage

import (
	"context"
	"log"
	"time"
)

// RunRetention 定时清理超期数据：本节点只保留 retentionMonths 月（电脑端 6、手机端 1），超过即删
func (db *DB) RunRetention(ctx context.Context, retentionMonths int) {
	if retentionMonths <= 0 {
		retentionMonths = 6
	}
	cutoffSec := int64(retentionMonths) * 30 * 24 * 3600 // 约 30 天/月
	ticker := time.NewTicker(24 * time.Hour) // 每日执行
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			now := time.Now().Unix()
			before := now - cutoffSec
			nTrades, err := db.DeleteTradesBefore(before)
			if err != nil {
				log.Printf("[retention] 清理 trades 失败: %v", err)
			} else if nTrades > 0 {
				log.Printf("[retention] 已清理 %d 条超期成交", nTrades)
			}
			nSnapshots, err := db.DeleteSnapshotsBefore(before)
			if err != nil {
				log.Printf("[retention] 清理 orderbook_snapshots 失败: %v", err)
			} else if nSnapshots > 0 {
				log.Printf("[retention] 已清理 %d 条超期订单簿快照", nSnapshots)
			}
		}
	}
}
