/**
 * 订单公告栏中继配置（无节点化阶段 5 定版：中继单源）。
 *
 * 中继是无许可的订单公告栏（Cloudflare Workers + D1，仓库 relay/ 目录）：
 * 订单是自验签便签，中继只存与转、无钥无钱。自第 51 轮（阶段 5 节点
 * 退役）起，中继是前端唯一的订单通道：
 * - 下单：签名订单直接 POST 到中继 /orders（见 services/orderService.ts）；
 * - 订单簿与「我的订单」：读中继 /orderbook（见 services/dualread/adapters.ts）；
 * - 成交记录：读链上索引 Envio（见 config/indexer.ts），不再经节点。
 *
 * 历史形态（本轮删除）：第 30 轮的「节点主发 + 中继副发」双发开关
 * （VITE_RELAY_DUAL_SEND）与第 34 轮的双读三态模式（VITE_RELAY_MODE =
 * disabled/shadow/active）都建立在节点还在的前提上，节点退役后不再
 * 存在「副发」与「双读」——中继即主通道，模式开关一并退役。
 *
 * 环境变量：
 * - VITE_RELAY_URL：中继基地址（如 https://bit100-relay.<账号>.workers.dev）。
 *   为空表示中继未配置：下单与订单簿不可用（界面如实呈现），链上资产、
 *   跨链与成交索引不受影响。
 */
export const RELAY_URL: string = (import.meta.env.VITE_RELAY_URL ?? '')
  .trim()
  .replace(/\/$/, '')

/** 中继是否已配置（下单/订单簿通道是否可用） */
export const RELAY_CONFIGURED: boolean = RELAY_URL !== ''
