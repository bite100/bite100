package storage

import (
	"context"
	"log"
	"time"
)

// RetentionDaysTwoWeeks 数据保留「两周」天数，与概念设计文档一致；retention_months<=0 时使用
const RetentionDaysTwoWeeks = 14

// RunRetention 定时清理超期数据：retentionMonths<=0 表示两周（14 天），>0 表示月数（约 30 天/月）
func (db *DB) RunRetention(ctx context.Context, retentionMonths int) {
	var cutoffSec int64
	if retentionMonths <= 0 {
		cutoffSec = int64(RetentionDaysTwoWeeks) * 24 * 3600
	} else {
		cutoffSec = int64(retentionMonths) * 30 * 24 * 3600
	}
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
			nOrders, err := db.DeleteOrdersBefore(before)
			if err != nil {
				log.Printf("[retention] 清理 orders 失败: %v", err)
			} else if nOrders > 0 {
				log.Printf("[retention] 已清理 %d 条超期订单", nOrders)
			}
		}
	}
}
