/**
 * EIP-712 域按链生成 —— 回归测试（第 25 轮验收堵点）：
 * 旧代码的 EIP712_DOMAIN 是静态 Sepolia 域，Base 构建下单签名仍走 Sepolia 域，
 * 会被 Base 节点验签拒绝。本测试锁定两链域必须各指各的 Settlement。
 */
import { describe, it, expect } from 'vitest'
import { getEIP712Domain, EIP712_DOMAIN } from './orderSigningTypes'

describe('getEIP712Domain', () => {
  it('Sepolia 域指向 Sepolia Settlement', () => {
    const d = getEIP712Domain(11155111)
    expect(d.name).toBe('比特100')
    expect(d.version).toBe('1')
    expect(d.chainId).toBe(11155111)
    expect(d.verifyingContract).toBe('0xa3F8cBCDc1533299D37836ea80d5004FF59f9094')
  })

  it('Base Sepolia 域指向 Base Settlement（与 Sepolia 不同）', () => {
    const d = getEIP712Domain(84532)
    expect(d.chainId).toBe(84532)
    expect(d.verifyingContract).toBe('0x39037dE0a1d6ca567d50055522f7Ef825dF4FCf9')
    expect(d.verifyingContract).not.toBe(EIP712_DOMAIN.verifyingContract)
  })

  it('默认域仍为 Sepolia（兼容旧调用）', () => {
    expect(EIP712_DOMAIN.chainId).toBe(11155111)
    expect(EIP712_DOMAIN.verifyingContract).toBe('0xa3F8cBCDc1533299D37836ea80d5004FF59f9094')
  })

  it('未登记链回落为传入的 chainId 与零地址（不冒充别链）', () => {
    const d = getEIP712Domain(999999)
    expect(d.chainId).toBe(999999)
    expect(d.verifyingContract).toBe('0x0000000000000000000000000000000000000000')
  })
})
