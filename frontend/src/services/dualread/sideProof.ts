/**
 * 逐单方向证明门禁（第 37 轮建立；阶段 3 定版）。
 *
 * 阻断移除 ⇔ 协议能力声明为真（SIDE_PROOF_AVAILABLE）
 *              ∧ 本单的签名证据证明其方向（orderSideProof 通过）
 *
 * 证明口径：订单的 EIP-712 签名类型集（验签/重算 digest 实际使用的
 * 那一份，即 digest.ts 传入 ethers TypedDataEncoder 的 types）必须
 * 在主类型（primaryType）中声明方向成员 `side`（阶段 3 已定名，见
 * docs/eip712-order-spec.md §2），且重构出的签名消息中的 side 值与
 * 各来源自报的 side 相符（buy/sell 规范化比较）。
 * 类型集不声明方向成员 ⇒ 签名根本没绑方向 ⇒ 证明恒不成立。
 *
 * 阶段 3 现实：ORDER_TYPES（services/orderSigningTypes.ts）的 Order
 * 结构已含 `side`（uint8，末位），重构（digest.ts buildSignedOrderData）
 * 把源行自报 side 写进签名消息参与 digest 与验签——自报被篡改的行
 * 重构出的 digest 与签名对不上、验签先行失败；验签通过的候选，其
 * data.side 即密码学意义上的签名方向。本门禁再核对全部副本自报值
 * 与之一致，任一不符即不成立（fail-closed）。第 36–37 轮的过渡体制
 * （SIDE_UNPROVABLE 恒阻断）自此结束：证明可得、逐单判定。
 *
 * 骑乘：类型集直接读 digest.ts 的同一份 ORDER_TYPES，不另建表。
 */
import { ORDER_TYPES, type OrderData } from '../orderSigningTypes'
import type { BookSource, RawOrder } from './types'

/** 方向成员名（阶段 3 已定名 side，不再留 direction 候选） */
const SIDE_MEMBER_NAME = 'side'

/** 方向成员可接受的签名值形态 → 自报 side 的规范化映射 */
const SIDE_VALUE_ALIASES: Record<string, 'buy' | 'sell'> = {
  buy: 'buy',
  sell: 'sell',
  '0': 'buy', // 签名枚举口径（阶段 3 定版）：0=buy / 1=sell
  '1': 'sell',
  true: 'buy', // 布尔形态兼容（防御性保留，现行协议不产生）
  false: 'sell',
}

export interface SideProofInput {
  /** 本单各来源自报 side（全部副本；任一与签名值不符即不成立） */
  reportedSides: Array<'buy' | 'sell'>
  /**
   * 实际用于本单验签/摘要的类型集（与 digest.ts 传给
   * TypedDataEncoder 的同一份）。缺省 = 现行 ORDER_TYPES。
   * 测试经 evaluateCandidate 的 opts 注入类型集夹具（如旧协议
   * 无 side 成员的类型集，用以锁死「无签名成员 ⇒ 证明不成立」）。
   */
  types?: Record<string, Array<{ name: string; type: string }>>
  /**
   * 签名消息中的方向成员值。数据源 = 候选重构出的 OrderData.side
   * （经 digest 重算 + 验签后即签名方向本身）；缺省 undefined →
   * 证明不成立。
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
  const member = primary.find((f) => f?.name === SIDE_MEMBER_NAME)
  if (!member) return false // 旧协议类型集走这里：不含方向成员
  if (input.signedSideValue === undefined || input.signedSideValue === null) {
    return false
  }
  const signed = SIDE_VALUE_ALIASES[String(input.signedSideValue).toLowerCase()]
  if (!signed) return false
  if (input.reportedSides.length === 0) return false
  return input.reportedSides.every((s) => s === signed)
}

/**
 * 从候选的各来源副本与重构签名消息提取证明输入。
 * data 为 digest.ts 重构出的签名订单（data.side 即参与 digest 的
 * 方向值）；缺省不传 data 时 signedSideValue 缺失、证明不成立。
 */
export function sideProofInputFromRaws(
  raws: Partial<Record<BookSource, RawOrder>>,
  data?: OrderData,
): SideProofInput {
  const reportedSides = (Object.values(raws) as RawOrder[])
    .map((r) => r?.side)
    .filter((s): s is 'buy' | 'sell' => s === 'buy' || s === 'sell')
  return { reportedSides, signedSideValue: data?.side }
}
