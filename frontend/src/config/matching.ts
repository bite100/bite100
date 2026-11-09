/**
 * 前端撮合灰度开关（阶段 3 块 C3）。
 *
 * 环境变量 VITE_FRONTEND_MATCHING：默认关（缺省/任何非 on 值都关）。
 * - 关：下单只广播到订单中继簿留簿，等待后续撮合（任何提交者都可
 *   按开放提交 B 模型结算，含订单双方自己的前端撮合）。
 * - 开（on/true/1）：下单成功广播后，前端在本机以中继簿可成交集
 *   （逐单验签 + 链上状态复核）即时撮合，并由用户钱包自提批结算；
 *   交易页会明示「前端撮合已开启」。未成交部分照常留簿。
 * 第 51 轮（阶段 5 节点退役）：原「节点路径」已不存在——开关关时
 * 不再有节点撮合/节点提交器兜底，留簿订单只能等任一提交者结算。
 */

const raw = (import.meta.env.VITE_FRONTEND_MATCHING ?? '').trim().toLowerCase()

export const FRONTEND_MATCHING_ENABLED: boolean =
  raw === 'on' || raw === 'true' || raw === '1'
