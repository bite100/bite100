/**
 * 第 62 轮块 F 第 11 项：位图 nonce 分配器单元测试。
 * 覆盖：空位图、链上已置位跳过、word 0 全满跨字、在途占用跳过、
 * 游标持久化与链上冲突时以链上为准（修剪已消耗的 inFlight + 扫描越位）。
 */
import { describe, expect, it } from 'vitest'
import {
  allocateNonce,
  createMemoryNonceCursorStorage,
  type NonceWordReader,
} from './nonceAllocator'

function readerWith(words: Record<number, bigint>): NonceWordReader {
  return {
    async readWord(wordPos: number) {
      return words[wordPos] ?? 0n
    },
  }
}

const FULL_WORD = (1n << 256n) - 1n

describe('位图 nonce 分配器（第 62 轮）', () => {
  it('空位图 → 取 0；连取第二单 → 1（在途占用，不等链上置位）', async () => {
    const storage = createMemoryNonceCursorStorage()
    const reader = readerWith({})
    await expect(allocateNonce(reader, storage)).resolves.toBe(0)
    // 链上仍是空位图（第一单未结算），靠 inFlight 防撞
    await expect(allocateNonce(reader, storage)).resolves.toBe(1)
    expect(storage.current()).toEqual({ cursor: 2, inFlight: [0, 1] })
  })

  it('位 0 已在链上置位 → 取 1', async () => {
    const storage = createMemoryNonceCursorStorage()
    await expect(allocateNonce(readerWith({ 0: 1n }), storage)).resolves.toBe(1)
  })

  it('word 0 全满 → 跨字取 256', async () => {
    const storage = createMemoryNonceCursorStorage()
    await expect(
      allocateNonce(readerWith({ 0: FULL_WORD, 1: 0n }), storage),
    ).resolves.toBe(256)
  })

  it('在途占用跳过：inFlight 含 0 且链上为空 → 取 1', async () => {
    const storage = createMemoryNonceCursorStorage({ cursor: 0, inFlight: [0] })
    await expect(allocateNonce(readerWith({}), storage)).resolves.toBe(1)
    expect(storage.current()?.inFlight).toEqual([0, 1])
  })

  it('游标与链上冲突时以链上为准：cursor=0 但 bit0 已被他端消耗 → 取 1 并推进游标', async () => {
    const storage = createMemoryNonceCursorStorage({ cursor: 0, inFlight: [] })
    await expect(allocateNonce(readerWith({ 0: 1n }), storage)).resolves.toBe(1)
    expect(storage.current()?.cursor).toBe(2)
  })

  it('inFlight 中已在链上消耗的 nonce 被修剪释放', async () => {
    // 本地记着 0 在途，但链上 bit0 已置位（他端视角下该单已结算）；
    // cursor 已在 1：分配 1 后，保存的 inFlight 只含 1、不含 0。
    const storage = createMemoryNonceCursorStorage({ cursor: 1, inFlight: [0] })
    await expect(allocateNonce(readerWith({ 0: 1n }), storage)).resolves.toBe(1)
    expect(storage.current()).toEqual({ cursor: 2, inFlight: [1] })
  })

  it('高位已置不影响低位分配：word 0 仅 bit 200 置位 → 仍取 0', async () => {
    const storage = createMemoryNonceCursorStorage()
    await expect(
      allocateNonce(readerWith({ 0: 1n << 200n }), storage),
    ).resolves.toBe(0)
  })
})
