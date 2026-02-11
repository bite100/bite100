package storage

import (
	"context"
	"log"
	"time"
	"database/sql"
)

// RetentionDaysTwoWeeks 数据保留「两周」天数，与概念设计文档一致；retention_months<=0 时使用
const RetentionDaysTwoWeeks = 14

// RunRetention 定时清理超期数据：retentionMonths<=0 表示两周（14 天），>0 表示月数（约 30 天/月）
// 优化：添加存储空间监控和批量操作优化
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
			
			// 存储空间监控：清理前记录数据库大小
			dbSizeBefore := db.getDatabaseSize()
			
			// 批量删除优化：使用事务批量删除
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
			
			// 存储空间监控：清理后记录数据库大小
			dbSizeAfter := db.getDatabaseSize()
			if dbSizeBefore > 0 {
				freed := dbSizeBefore - dbSizeAfter
				log.Printf("[retention] 存储空间：清理前 %d bytes，清理后 %d bytes，释放 %d bytes", dbSizeBefore, dbSizeAfter, freed)
			}
			
			// 执行VACUUM优化数据库（可选，定期执行）
			if nTrades+nSnapshots+nOrders > 1000 {
				if err := db.vacuumDatabase(); err != nil {
					log.Printf("[retention] VACUUM 失败: %v", err)
				} else {
					log.Printf("[retention] 已执行 VACUUM 优化")
				}
			}
		}
	}
}

// getDatabaseSize 获取数据库大小（用于监控）
func (db *DB) getDatabaseSize() int64 {
	var pageCount, pageSize int64
	if err := db.sql.QueryRow("PRAGMA page_count").Scan(&pageCount); err != nil {
		return 0
	}
	if err := db.sql.QueryRow("PRAGMA page_size").Scan(&pageSize); err != nil {
		return 0
	}
	return pageCount * pageSize
}

// vacuumDatabase 执行VACUUM优化数据库
func (db *DB) vacuumDatabase() error {
	_, err := db.sql.Exec("VACUUM")
	return err
}
