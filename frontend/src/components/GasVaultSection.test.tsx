import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { GasVaultSection, isGasVaultDeployed, gasVaultWaterLevel } from './GasVaultSection'

/**
 * 第 63 轮 gas-2：gas库分区。
 * 测试环境链配置未填 gasVault 地址（部署属部署步）——组件必须如实显示
 * 「尚未部署开放」并给出完整使用说明，绝不伪造池子数据或存取入口。
 */

describe('isGasVaultDeployed', () => {
  it('undefined / 零地址 = 未部署', () => {
    expect(isGasVaultDeployed(undefined)).toBe(false)
    expect(isGasVaultDeployed('')).toBe(false)
    expect(isGasVaultDeployed('0x0000000000000000000000000000000000000000')).toBe(false)
    expect(isGasVaultDeployed('0x1111111111111111111111111111111111111111')).toBe(true)
  })
})

describe('gasVaultWaterLevel', () => {
  it('目标未设 = unset；低于警戒线 = low；其余 ok（等号不算低）', () => {
    expect(gasVaultWaterLevel(0n, 0n, 0n)).toBe('unset')
    expect(gasVaultWaterLevel(39n, 100n, 40n)).toBe('low')
    expect(gasVaultWaterLevel(40n, 100n, 40n)).toBe('ok')
    expect(gasVaultWaterLevel(90n, 100n, 40n)).toBe('ok')
  })
})

describe('GasVaultSection（未部署链）', () => {
  it('显示使用说明四件套与未开放如实声明，不出现存取按钮', () => {
    const html = renderToStaticMarkup(<GasVaultSection account={null} />)
    expect(html).toContain('gas库')
    // 干什么 / 前提 / 步骤 / 注意事项
    expect(html).toContain('干什么：gas库 是全站结算的 gas 周转池')
    expect(html).toContain('前提：需要连接钱包')
    expect(html).toContain('步骤：① 输入金额')
    expect(html).toContain('注意事项：暂停只会停「存入」')
    // 未部署如实声明 + 防诈骗提醒
    expect(html).toContain('尚未部署开放')
    expect(html).toContain('请勿向任何自称 gas库 的地址存款')
    // 未部署时不渲染任何存取动作（说明文案会提到按钮名，故钉 button 元素本身）
    expect(html).not.toContain('<button')
  })
})
