import { describe, it, expect } from 'vitest'
import { decodeExtraArgs } from '@chainlink/ccip-sdk/dist/evm/extra-args.js'
import {
  buildCcipExtraArgs,
  buildCcipMessage,
  buildNttSingleTransceiverInstructions,
  LAYERZERO_OPTIONS_EMPTY,
} from './bridgeExecutors'
import { getChainConfig } from '../config/chains'

/**
 * 第 63 轮桥-4 编码器迁移的字节对拍：迁移的验收标准是「新编码器产出与旧手拼
 * 常量逐字节一致」（LZ options 除外：旧裸 '0x' 不是合法的 type-3 容器，迁移
 * 目标就是规范化为 '0x0003'，语义同为零 options——差异在此明示并钉住）。
 * 任一官方包升级导致产出变化，这组测试会第一时间红——那正是要的效果：
 * 编码变化必须显式评审，不许悄悄漂移。
 */
describe('桥-4 编码器迁移字节对拍', () => {
  it('CCIP extraArgs：SDK 编码 === 旧手拼常量（tag + 15 字节零）', () => {
    const OLD_HAND_PACKED = '0xa69dd4aa' + '00'.repeat(15)
    expect(buildCcipExtraArgs()).toBe(OLD_HAND_PACKED)
  })

  it('CCIP extraArgs：SDK 解码回读字段与预期一致（V3 全默认）', () => {
    const decoded = decodeExtraArgs(buildCcipExtraArgs())
    expect(decoded?._tag).toBe('GenericExtraArgsV3')
    if (decoded?._tag === 'GenericExtraArgsV3') {
      expect(decoded.gasLimit).toBe(0n)
      expect(decoded.finality).toBe('finalized')
      expect(decoded.ccvs).toEqual([])
      expect(decoded.executor).toBe('')
      expect(decoded.tokenReceiver).toBe('')
    }
  })

  it('buildCcipMessage 的 extraArgs 走新编码器（与旧常量一致）', () => {
    const sepolia = getChainConfig(11155111)!
    const msg = buildCcipMessage(sepolia, '0xE83D2b08356cb463adFc20406a18B79991F7eE29', 1000n)
    expect(msg.extraArgs).toBe('0xa69dd4aa' + '00'.repeat(15))
    expect(msg.feeToken).toBe('0x0000000000000000000000000000000000000000')
  })

  it('LayerZero options：保持裸 0x（Options 构造器的 0x0003 经实测在现行桥上报价 revert，不迁）', () => {
    // 证据（2026-11-10 Sepolia 实读，桥-4 硬门）：quoteBridgeFee 带 '0x0003'
    // revert（unknown custom error），带 '0x' 正常返回 nativeFee=104027936596558。
    expect(LAYERZERO_OPTIONS_EMPTY).toBe('0x')
  })

  it('Wormhole NTT 指令：SDK layout 编码 === 旧常量 0x010000', () => {
    expect(buildNttSingleTransceiverInstructions()).toBe('0x010000')
  })
})
