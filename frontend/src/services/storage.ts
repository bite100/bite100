/**
 * 交易数据本地持久化 - 统一入口
 *
 * 层级：IndexedDB (Dexie) 存订单、撮合、链上同步成交；
 * 链上为最终权威，此处为「本地历史 + 链上确认」体验。
 *
 * 实现位于 p2p/storage.ts，本文件仅做 re-export 与别名，便于按文档路径引用。
 */
import {
  DatabaseManager,
  OrderStorage,
  MatchStorage,
  TradeStorage,
  saveMatchAndUpdateMaker,
  type OrderStatus,
  type StoredOrder,
  type Match,
  type OnChainTrade,
} from '../p2p/storage'
import type { Trade } from '../p2p/types'

export { DatabaseManager, OrderStorage, MatchStorage, TradeStorage }
export type { OrderStatus, StoredOrder, Match, OnChainTrade }

/** 保存新订单（status: pending） */
export const saveOrder = OrderStorage.saveOrder.bind(OrderStorage)

/** 撮合成功后：保存 Match 并更新 maker 订单状态；可选传入 txHash（链上确认后更新） */
export async function saveMatchAndTrade(trade: Trade, txHash?: string): Promise<void> {
  await saveMatchAndUpdateMaker(trade, txHash)
}

/** 启动时加载本地活跃订单到内存（pending/partial，任意交易对） */
export async function loadActiveOrders(): Promise<StoredOrder[]> {
  return OrderStorage.getAllActiveOrders()
}

export { saveMatchAndUpdateMaker }
