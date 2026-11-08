/**
 * 第 36 轮 — 协议能力事实（方向可证明性）。
 *
 * 现行 EIP-712 签名结构（docs/eip712-order-spec.md）不含订单方向：
 * Order 结构只有 tokenIn/tokenOut，而二者恒为交易对的 Token0/Token1、
 * 与买卖方向无关（前端/节点/中继三方实现一致）。方向（side）只是
 * 数据源自报的未签名字段，任何副本都可改写而不影响 digest 与验签。
 *
 * 第 35 轮曾试图以 Vault 锁仓代币作为方向的链上证据，第 35 轮推送后
 * 复审（N1）证伪：Vault.lockForOrder 的方向参数 payWithTokenIn 由
 * 调用者自填、且该函数自第 30 轮起无许可（L2），锁定代币只证明
 * 「有人按某个方向义务落了锁」，不证明挂单人的真实方向；先到先得
 * 还使第三方可抢先按错误方向落锁。故在当前协议下：
 *
 *   **没有任何订单的方向是可证明的**——来源一致不是独立证据（节点与
 *   中继同吃同一份广播），锁仓一致也不是（落锁方向由调用者选择）。
 *
 * 本常量是协议能力声明（第 37 轮起不再是唯一开关）：
 * - false（当前）：观察评估照常（VALID/UNKNOWN/INVALID 分类、发现、
 *   一致性统计都不受影响），但可成交认证对所有订单关闭——每单带
 *   SIDE_UNPROVABLE 阻断码，不进可成交集。
 * - 阻断的实际移除条件（第 37 轮落实为代码，见 sideProof.ts）：
 *   本常量为 true ∧ evaluate.ts 的逐单方向证明 orderSideProof 通过。
 *   证明口径 = 本单验签所用 EIP-712 类型集声明了方向成员且签名值
 *   与自报 side 相符。现行 ORDER_TYPES 无方向成员 ⇒ 证明恒不成立
 *   ⇒ 仅改本常量无法放行任何订单（回归测试锁死）。
 * - 真正的解除路径仍是阶段 3 协议轮：side 纳入 EIP-712 签名结构、
 *   Vault/Settlement 链上强制执行方向（与 B 开放提交模型、
 *   ERC-1271 签名长度修复同轮捆绑，双链重部署完成），届时证明
 *   函数按新类型集逐单判定，本常量才改 true。
 */
export const SIDE_PROOF_AVAILABLE = false

/** 方向不可证时的可成交认证阻断原因码（与 validity 判定原因码分开统计） */
export const SIDE_UNPROVABLE = 'SIDE_UNPROVABLE'
