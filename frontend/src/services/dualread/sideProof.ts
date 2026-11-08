/**
 * 第 37 轮 — 逐单方向证明门禁（第 36 轮推送后复审高优先项 #2）。
 *
 * 第 36 轮的过渡期设计里，解除 SIDE_UNPROVABLE 阻断的条件只写在
 * protocol.ts 的注释里：代码中把 SIDE_PROOF_AVAILABLE 改成 true，
 * done() 就会给所有订单清空阻断码——没有任何逐单证据检查。本模块
 * 把解除条件落成代码事实：
 *
 *   阻断移除 ⇔ 协议能力声明为真（SIDE_PROOF_AVAILABLE）
 *              ∧ 本单的签名证据证明其方向（orderSideProof 通过）
 *
 * 证明口径：订单的 EIP-712 签名类型集（验签/重算 digest 实际使用的
 * 那一份，即 digest.ts 传入 ethers TypedDataEncoder 的 types）必须
 * 在主类型（primaryType）中声明一个方向成员——成员名为 side 或
 * direction（阶段 3 协议轮二选一并写入 eip712-order-spec），且该
 * 成员的签名值与来源自报的 side 相符（buy/sell 规范化比较）。
 * 类型集不声明方向成员 ⇒ 签名根本没绑方向 ⇒ 证明恒不成立。
 *
 * 现行 ORDER_TYPES（services/orderSigningTypes.ts）的 Order 结构
 * 不含方向成员，所以在现行协议下本函数对任何可构造订单恒返回
 * false——这是设计意图：阶段 3 协议轮把 side 写入签名结构、四方
 * 同步（前端签名/验签、节点、 中继、Settlement）并双链重部署后，
 * 本门禁才会逐单放行；仅改常量无法伪造认证（回归测试锁死）。
 *
 * 骑乘：类型集直接读 digest.ts 的同一份 ORDER_TYPES，不另建表。
 */
import { ORDER_TYPES } from '../orderSigningTypes'
import type { BookSource, RawOrder } from './types'

/** 方向成员的候选名（阶段 3 协议轮定名后只保留其一并同步规范文档） */
const SIDE_MEMBER_NAMES = ['side', 'direction'] as const

/** 方向成员可接受的签名值形态 → 自报 side 的规范化映射 */
const SIDE_VALUE_ALIASES: Record<string, 'buy' | 'sell'> = {
  buy: 'buy',
  sell: 'sell',
  '0': 'buy', // 枚举形态预留：0=buy / 1=sell（阶段 3 定名时确认）
  '1': 'sell',
  true: 'buy', // 布尔形态预留：true=buy（isBuy 式命名时）
  false: 'sell',
}

export interface SideProofInput {
  /** 本单各来源自报 side（全部副本；任一与签名值不符即不成立） */
  reportedSides: Array<'buy' | 'sell'>
  /**
   * 实际用于本单验签/摘要的类型集（与 digest.ts 传给
   * TypedDataEncoder 的同一份）。缺省 = 现行 ORDER_TYPES。
   * 测试经 evaluateCandidate 的 opts 注入未来类型集夹具。
   */
  types?: Record<string, Array<{ name: string; type: string }>>
  /**
   * 签名消息中的方向成员值。数据源在阶段 3 协议下随订单行携带
   * （RawOrder.side 签名后即成为签名消息的一部分）；现行协议无
   * 此值，缺省 undefined → 证明不成立。
   */
  signedSideValue?: unknown
}

/**
 * 逐单方向证明：签名是否真的绑定了本单方向。
 * 任一不确定（无类型集、无方向成员、无签名值、值不可解析、任一
 * 副本自报与签名值不符）→ false（fail-closed）。
 */
export function orderSideProof(input: SideProofInput): boolean {
  const types = input.types ?? (ORDER_TYPES as unknown as SideProofInput['types'])
  if (!types) return false
  const primary = types.Order ?? Object.values(types)[0]
  if (!Array.isArray(primary)) return false
  const member = primary.find((f) =>
    (SIDE_MEMBER_NAMES as readonly string[]).includes(f?.name),
  )
  if (!member) return false // 现行协议走这里：类型集不含方向成员
  if (input.signedSideValue === undefined || input.signedSideValue === null) {
    return false
  }
  const signed = SIDE_VALUE_ALIASES[String(input.signedSideValue).toLowerCase()]
  if (!signed) return false
  if (input.reportedSides.length === 0) return false
  return input.reportedSides.every((s) => s === signed)
}

/** 从候选的各来源副本提取证明输入（现行 RawOrder 无签名字段 → signedSideValue 恒缺省） */
export function sideProofInputFromRaws(
  raws: Partial<Record<BookSource, RawOrder>>,
): SideProofInput {
  const reportedSides = (Object.values(raws) as RawOrder[])
    .map((r) => r?.side)
    .filter((s): s is 'buy' | 'sell' => s === 'buy' || s === 'sell')
  return { reportedSides }
}
