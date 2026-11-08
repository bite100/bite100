/**
 * 前端撮合灰度开关（阶段 3 块 C3）。
 *
 * 环境变量 VITE_FRONTEND_MATCHING：默认关（缺省/任何非 on 值都关）。
 * - 关（默认）：下单走既有节点路径（广播 → 节点撮合 → 节点守护提交器
 *   结算），行为与阶段 3 之前完全一致——这是回滚点。
 * - 开（on/true/1）：下单成功广播后，前端在本机以双读可成交集即时
 *   撮合，并由用户钱包自提批结算（开放提交 B 模型）；交易页会明示
 *   「前端撮合已开启」。节点路径仍在（广播照常），链上累计成交校验
 *   保证同一订单不会被两条通道重复结算（先落链者生效，后者回滚、
 *   gas 由其发起者自担——切换期双通道并存的已知代价，见阶段 3
 *   轮文档的切换 runbook：正式启用前端撮合时应同步收起节点提交器）。
 */

const raw = (import.meta.env.VITE_FRONTEND_MATCHING ?? '').trim().toLowerCase()

export const FRONTEND_MATCHING_ENABLED: boolean =
  raw === 'on' || raw === 'true' || raw === '1'
