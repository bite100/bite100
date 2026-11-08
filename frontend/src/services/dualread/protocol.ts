/**
 * 协议能力事实（方向可证明性）。第 36 轮建立过渡体制，阶段 3 定版。
 *
 * 历史（第 36–37 轮）：旧 EIP-712 签名结构不含订单方向，side 只是
 * 数据源自报的未签名字段；锁仓方向（旧 lockForOrder 的 payWithTokenIn
 * 参数）由落锁调用者自填、证明不了挂单人方向（第 35 轮复审 N1）。
 * 故当时 **没有任何订单的方向是可证明的**，本常量为 false，每单恒带
 * SIDE_UNPROVABLE 阻断，可成交集按构造为空。
 *
 * 阶段 3（本分支）：解除条件已全部落地——
 * - side 进入 EIP-712 签名结构（ORDER_TYPES 含 uint8 side，末位）；
 * - Settlement 链上强制方向（成交付款侧与签名方向比对）；
 * - Vault 落锁方向只从签名 side 派生（方向参数已删除）；
 * - 前端/节点/中继/索引器四方同轮同步新结构体。
 * 本常量随之改 true，阻断的移除仍须逐单过 sideProof.ts 的方向证明
 * （类型集含 side 成员 ∧ 重构签名值与全部副本自报一致），不是无条件
 * 放行：旧协议订单（按旧类型集验签的夹具/历史行）在逐单证明处仍被
 * 拦下。**注意切换纪律**：本分支是「切换后」的代码状态——线上旧
 * Settlement 仍按旧类型哈希验签，本分支只能在切换日与新合约、节点、
 * 中继同批上线（runbook 见阶段 3 轮文档），不得提前单独部署。
 */
export const SIDE_PROOF_AVAILABLE = true

/** 方向不可证时的可成交认证阻断原因码（与 validity 判定原因码分开统计） */
export const SIDE_UNPROVABLE = 'SIDE_UNPROVABLE'

/**
 * 链上状态未证时的可成交认证阻断原因码（第 42 轮补，窗口 1 遗留裁定）：
 * 阶段 3 前 tradableBlockers 只表达方向证明一件事——链上未知
 * （chainKnown=false）的订单在方向证明通过时该字段为空，fail-closed
 * 只靠 mergeBooks 把「validity=VALID ∧ 无阻断」做合取这一处实现；
 * 任何只读本字段的消费方（或未来重构合取）都会把链上未证订单误认
 * 为无阻断（3A 浸泡窗口 1 的 tradeable 异常计数即此形态）。第 42 轮
 * 起：chainKnown=false ⇒ 本阻断恒在，字段本身即 fail-closed，
 * validity 语义（VALID/UNKNOWN/INVALID）不变。
 */
export const CHAIN_UNPROVEN = 'CHAIN_UNPROVEN'
